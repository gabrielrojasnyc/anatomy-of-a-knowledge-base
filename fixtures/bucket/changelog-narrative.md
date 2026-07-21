---
title: Changelog Narrative (Pre-Launch Draft)
author: Gabe Rojas
date: 2026-06-18
type: draft
tags: [changelog, launch]
---

# Changelog Narrative

Draft narrative version of the changelog, meant to read as a story of the last year rather than a bare list of tickets. Trim before publishing.

## Early 2025: finding the rough edges

The team spent the first stretch of the year running into the kind of problems you only find at scale: a shard cache that thrashed under concurrent restores, a router that got slow once the replica fleet grew past what it was built for, a compiler that ran out of memory on large batch graphs. None of these were dramatic individually. Together they shaped a lot of the hardening work that followed.

## Mid 2025: storage gets serious attention

The checkpoint restore stall, later written up as its own postmortem, was the turning point for how seriously storage tuning got treated. It led directly to the prefetch depth runbook, and later to an RFC on auto-detecting mount type so the tuning mismatch that caused it cannot recur silently.

## Late 2025 into 2026: rollout safety

Blue-green deploys worked, but gave no gradual exposure. The team moved to canary as the default rollout strategy, with an automatic ramp schedule and rollback on regression, a direct response to a string of near misses and one open incident about a stalled manual ramp.

## What is next

Retention policy tightened from 30 to 14 days on cost grounds this spring. Auto-detected prefetch depth is scoped but not yet built. Read-only API scopes shipped to reduce how many internal tools carry admin tokens they do not need.
