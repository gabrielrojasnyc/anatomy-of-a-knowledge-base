---
title: Launch Talking Points
author: Gabe Rojas
date: 2026-06-22
type: draft
tags: [launch, talking-points]
---

# Launch Talking Points

Draft talking points for anyone doing launch-adjacent interviews or calls. Keep answers short, defer detail to the docs.

## If asked "why now"

Helios has been running real production workloads internally for over a year. Launch is not a bet on an unproven system, it is opening up something that has already been hardened against the failure modes that matter: slow restores, bad rollouts, misconfigured serving nodes.

## If asked about pricing

Two tiers: Serve is usage-based, no minimum. Dedicated is capacity-based with a commitment term. Exact figures live in the pricing draft, do not improvise numbers on a call, point people to the doc or to sales.

## If asked about reliability

Point to the deploy process: canary rollouts with automatic rollback on regression, replacing an earlier all-at-once approach. Point to restore behavior: failures are loud and specific rather than silent hangs, a direct lesson from an early incident.

## If asked what is not ready yet

Be honest that some observability, like real-time restore progress, is new and still maturing. Do not oversell maturity we do not have.

## If asked about competitors

Do not compare by name in a launch conversation. Redirect to what Helios does well: the operational discipline around restore and rollout, not a feature checklist race.

## Closing line

Helios is built by people who have been paged for the exact problems it now catches before they become someone else's incident.
