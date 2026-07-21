---
title: Postmortem Draft: Checkpoint Restore Stall (HEL-482)
author: Gabe Rojas
date: 2026-05-10
type: draft
tags: [postmortem, incident, checkpoint]
---

# Postmortem Draft: Checkpoint Restore Stall

Draft writeup, pulling together the incident thread for a wider audience before it goes out internally.

## What happened

A 128-shard training checkpoint restore hung indefinitely after the manifest loaded, with no error in the loader logs. Smaller runs were unaffected, which delayed diagnosis: nothing pointed at scale as the variable until Owen reproduced it deliberately on staging.

## Root cause

The checkpoint loader defaults its prefetch depth to 16, a value tuned for local SSD. On clusters where the checkpoint directory sits on an NFS mount, that concurrency saturates the mount and every read queues behind every other read, with no timeout to surface the problem. Priya traced it to `HELIOS_PREFETCH_DEPTH` and confirmed the fix: `HELIOS_PREFETCH_DEPTH=4` let the restore complete normally.

## Why it took as long as it did

No single shard failed, so there was nothing to alert on. The restore looked identical to a slow-but-healthy run right up until it was well outside normal duration. This is the gap the follow-up RFC on auto-detecting mount type is meant to close.

## Draft talking points for the wider writeup

Emphasize that this was a tuning mismatch, not data loss or corruption risk. Emphasize the fix is already live as a documented runbook. Note the follow-up work is scoped but not yet built.
