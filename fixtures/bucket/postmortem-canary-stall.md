---
title: Postmortem Draft: Canary Rollout Stuck at 5 Percent
author: Gabe Rojas
date: 2026-06-15
type: draft
tags: [postmortem, incident, serving]
---

# Postmortem Draft: Canary Rollout Stuck at 5 Percent

Second postmortem draft, this one from the newer canary process rather than the older checkpoint restore incident.

## What happened

A serving deploy under the new canary rollout process sat at five percent traffic for over an hour with no automatic progression, even though metrics on the canary pool looked healthy the entire time. The engineer running the rollout had stepped away after setting the initial weight.

## Root cause

The ramp stages in the canary process were, at the time, manual steps rather than an automated schedule. Nothing advanced the rollout on its own, and nothing alerted that a rollout had stalled partway through. This is a process gap, not a bug in the router itself.

## What changed as a result

A ramp scheduler now steps through configured stages automatically, checking error rate before each advance and aborting back to zero weight on regression. This closes the exact gap this incident exposed.

## Contrast with the earlier restore postmortem

Where the checkpoint restore incident was a tuning mismatch invisible until scale, this one was a process design gap, invisible until someone stepped away mid-rollout. Different failure shape, same lesson: anything that can be forgotten by a human eventually will be.

## Draft talking points

This is a good example of the kind of gradual-rollout safety net that comes standard with canary. Worth noting the fix landed within the same sprint the gap was found.
