---
title: Style Notes for Helios Content
author: Gabe Rojas
date: 2026-06-25
type: draft
tags: [style, content, internal]
---

# Style Notes for Helios Content

Working notes on voice and style for anything written about Helios, internal or external. Living document, update as we learn what works.

## Voice

Direct, specific, a little understated. We are describing infrastructure people depend on, not selling a lifestyle. Avoid superlatives that cannot be backed by a number or a specific claim.

## Punctuation

No double dashes, no em dashes, anywhere. Use commas, colons, or periods instead, or restructure the sentence so you do not need the interruption at all.

## Numbers over adjectives

Say "restores complete in under two minutes on a 128-shard checkpoint" rather than "restores are fast." Specific numbers are more credible and more useful to a reader deciding whether Helios fits their workload.

## Incident and postmortem language

When referencing a past incident in external-facing content, describe what changed as a result, not just what went wrong. A postmortem that ends at root cause without a resolution reads as unfinished.

## Naming conventions

Refer to the two deploy processes as blue-green and canary consistently, do not invent synonyms. Refer to checkpoint retention as a policy, not a promise, since it is subject to change on cost grounds, as it already has once.

## Review

Anything customer-facing gets a pass from Gabe before it ships, no exceptions for time pressure.
