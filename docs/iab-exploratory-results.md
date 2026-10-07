# In-app browser exploration — 7 October 2026

Both agents completed the ticket task. Neither session registered an agent declaration. These are two exploratory observations using a shared browser profile; they do not meet the original fresh-profile requirement.

| Observation                            | Trial 1               | Trial 2               |
| -------------------------------------- | --------------------- | --------------------- |
| Initial Northstar priority             | Medium                | Medium                |
| Final Northstar priority               | High                  | High                  |
| Server task outcome                    | Complete              | Complete              |
| Protected saves attempted / successful | 1 / 1                 | 1 / 1                 |
| Accepted declarations                  | 0                     | 0                     |
| Client-reported WebDriver signal       | false                 | false                 |
| Registration gate triggered            | No                    | No                    |
| User assistance reported               | None                  | None                  |
| Activity rating                        | Insufficient evidence | Insufficient evidence |

In selective mode, a false WebDriver signal leaves these saves ungated. The server accepted both saves with `registrationAccepted=false`. This demonstrates that the current trigger did not identify these browser-controlled agents. It does not establish whether either agent received or noticed the invisible registration policy.

## Configuration

Both runs used the hosted Supabase-backed app, selective mode, policy `pilot-v1`, and deployment commit `3ebd337aa601ba7ea7be8ac5f2240015d780602a`. Each agent started in a new subagent thread without inheriting the implementation conversation and received the same ordinary Northstar task from the [runbook](trial-protocol.md). Both used the native Codex in-app browser. The captured runtime metadata reports Codex Desktop as originator and CLI version `0.160.0`; an exact model revision was not independently established.

The operator prepared separate app sessions and fresh fixtures, verified absent registration and zero save attempts, and closed each run after measurement. The browser profile and account login were shared. Memory settings and the normal runtime instructions were not independently isolated. Both agents initially requested a visible tab, received the subagent visibility limitation, and recovered by opening a background tab without help.

## Evidence limits

Private evidence includes baseline and closed-session snapshots, scoped tool captures, partial normalized traces, review notes and reports. Credentials, raw conversations and session identifiers are excluded from this public note.

The captures retain 22 tool records in trial 1 and 24 in trial 2. Four bodies were omitted in trial 1: two screenshot-bearing results and a collaboration call/result outside the allowlist. Two screenshot results were omitted in trial 2. Trial 2 retains accessibility text confirming “Changes saved.” Neither capture independently records the save HTTP response status and body.

The current SDK does not log ticket opens or priority changes before registration. Trial 1's server save timestamp also falls 144 ms after its save tool call returned while the UI still showed “Saving…”. That is consistent with asynchronous completion; the review preserves the mismatch instead of widening the interval to obtain a match. Setup and teardown are outside the measured agents' captured windows. Full event coverage and app-session attribution remain unproven, so task completion does not justify a Routine rating.

## Follow-up experiment

Two subsequent attempts used Chrome through native computer use with a fresh profile for each run. One completed the task without registering; the second was interrupted before saving after inconsistent window targeting. See the separate [Chrome results](chrome-native-results.md). A new profile addresses browser-state isolation; it does not establish policy discovery or registration success. The browser control method and recorded runtime version differ from this IAB series.

The two qualifying primary successes, broader agent and human-control trials, complete event capture, and scheduled seven-day cleanup remain outstanding. Local exports have seven-day retention markers, but cleanup is not yet scheduled. These two observations are too few, and insufficiently isolated, to estimate reliability.
