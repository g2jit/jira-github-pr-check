// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html#License

"use strict";

import * as githubApi from "./src/github-status.js";
import { setFailed } from "@actions/core";
import { context } from "@actions/github";
import * as jira from "./src/jira-status.js";

const JIRA_COMMIT_PATTERN = /^([A-Z]+-\d+)\u0020\w/;
const PR_BODY_VAR_PATTERN = /^([A-Z_]+)=(.*?)(\s*#.*)?$/gm;

function parseMessage(message) {
	const match = JIRA_COMMIT_PATTERN.exec(message);
	if (!match) {
		return null;
	}
	return match[1];
}

function parsePullRequestFlags(body) {
	PR_BODY_VAR_PATTERN.lastIndex = 0; // reset /g regex
	let prFlags = {};
	let match;
	// eslint-disable-next-line no-cond-assign
	while ((match = PR_BODY_VAR_PATTERN.exec(body))) {
		let value = match[2];
		if (value === "true") {
			value = true;
		} else if (value === "false") {
			value = false;
		} else if (!isNaN(parseFloat(value))) {
			value = parseFloat(value);
		}
		prFlags[match[1]] = value;
	}
	return prFlags;
}

async function getJiraInfo(pullRequest) {
	const prFlags = parsePullRequestFlags(pullRequest.body);
	const issueKey = parseMessage(pullRequest.title);
	if (!issueKey) {
		setFailed("Pull request title must start with a Jira ticket ID");
		return;
	}

	// Load additional data from Jira and GitHub
	const [jiraIssue, commits] = await Promise.all([
		jira.getStatus(issueKey),
		githubApi.getCommits({
			owner: pullRequest.base.repo.owner.login,
			repo: pullRequest.base.repo.name,
			pull_number: pullRequest.number,
		}),
	]);
	const jiraStatus = jiraIssue && jiraIssue.fields.status.name;
	const isMaintMerge =
		(pullRequest.base.ref === "master" || pullRequest.base.ref === "main") &&
		pullRequest.head.ref.match(/^maint\//) &&
		pullRequest.base.repo.full_name == pullRequest.head.repo.full_name;

	// Check Jira ticket for validity
	if (
		jiraStatus !== "Accepted" &&
		jiraStatus !== "Reviewing" &&
		jiraStatus !== "Review Feedback"
	) {
		setFailed(jiraStatus === null
			? "Jira ticket " + issueKey + " not found"
			: "Jira ticket " +
			  issueKey +
			  " is not accepted; it has status " +
			  jiraStatus)
		return;
	}

	// Check for consistency with the commit messages
	for (const commitInfo of commits) {
		const commitIssueKey = parseMessage(commitInfo.commit.message);
		if (commitIssueKey === null) {
			setFailed("Commit message for " +
			commitInfo.sha.substr(0, 7) +
			" fails validation");
			return;
		} else if (
			commitIssueKey !== issueKey &&
			!prFlags["DISABLE_JIRA_ISSUE_MATCH"] &&
			!isMaintMerge
		) {
			setFailed("Please fix your commit messages to have the same ticket number as the pull request. If the inconsistency is intentional, you can disable this warning with DISABLE_JIRA_ISSUE_MATCH=true in the PR description.");
			return;
		}
	}

	// Since we can't easilly check more than 100 commits, reject PRs with more than 100 commits
	if (commits.length === 100) {
		setFailed("PR has more than 100 commits; please rebase and squash");
		return;
	}

	// All checks passed
}

const DO_NOT_TOUCH_REPOS = (process.env.DO_NOT_TOUCH_REPOS || "").split(",");

async function touch(pullRequest, jiraInfo) {
	const owner = pullRequest.base.repo.owner.login;
	const repo = pullRequest.base.repo.name;
	if (DO_NOT_TOUCH_REPOS.indexOf(owner + "/" + repo) !== -1) {
		console.log("Not touching: repo is " + owner + "/" + repo);
		return;
	}
	const pull_number = pullRequest.number;
	const state = pullRequest.state;
	if (state !== "open") {
		console.log("Not touching: PR is " + state + ": " + pull_number);
		return;
	}
	const multiCommitPass =
		jiraInfo.numCommits === 1 ||
		(jiraInfo.numCommits > 1 &&
			(jiraInfo.isMaintMerge || jiraInfo.prFlags["ALLOW_MANY_COMMITS"]));
	const multiCommitMessage =
		jiraInfo.numCommits === 0
			? "No commits found on PR"
			: jiraInfo.numCommits === 1
			? "This PR includes exactly 1 commit!"
			: "This PR has " +
			  jiraInfo.numCommits +
			  " commits" +
			  (multiCommitPass ? "" : "; consider squashing:");
	const promises = [
		githubApi.createStatus(
			"jira-ticket",
			pullRequest,
			jiraInfo.pass,
			url,
			jiraInfo.description
		),
		githubApi.createStatus(
			"single-commit",
			pullRequest,
			multiCommitPass,
			url,
			multiCommitMessage
		),
	];
	if (jiraInfo.isMaintMerge) {
		promises.push(
			githubApi.createStatus(
				"maint-merge",
				pullRequest,
				false,
				undefined,
				"Reminder: use a MERGE COMMIT and new ticket in the message."
			)
		);
	}
	return Promise.all(promises);
}

try {
	const pullRequest = context.payload;
	console.log(pullRequest);
	const jiraInfo = await getJiraInfo(pullRequest);
	await touch(pullRequest, jiraInfo);
} catch (error) {
	setFailed(error.message);
}
