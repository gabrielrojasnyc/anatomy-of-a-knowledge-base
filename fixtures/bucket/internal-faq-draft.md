---
title: Internal FAQ Draft (Launch Prep)
author: Gabe Rojas
date: 2026-06-01
type: draft
tags: [faq, launch, internal]
---

# Internal FAQ Draft

Working draft to prep the team for questions that will come up around launch. Not for external distribution yet.

## Is this just another inference API?

No. The pitch is the operational surface around serving, not the serving call itself: restore reliability, gradual rollout, retention policy, and observability are all part of what customers are buying, even if they never see that machinery directly.

## What happens if a checkpoint restore fails during a customer's deploy?

Restore fails loudly rather than hanging silently, with a specific error naming what went wrong, whether that is a manifest fetch timeout or a checksum mismatch. Customers on Dedicated get a status page reflecting restore state; this is not yet exposed for Serve.

## How long are checkpoints retained?

Internally, training checkpoints are retained 14 days as of a recent cost-driven policy change. This is an internal retention policy for our own training pipeline, distinct from anything we promise customers about their own data, which follows separate contractual terms.

## What is the deploy process customers should expect if we ship a bad update?

Canary rollout, watched at each stage, with automatic rollback if error rate or latency regresses. This replaced an earlier blue-green process that gave less gradual exposure.

## Who do I forward hard questions to?

Anything about pricing or contracts goes to sales leadership. Anything technical goes to the eng team directly, do not guess at an answer in a customer-facing channel.
