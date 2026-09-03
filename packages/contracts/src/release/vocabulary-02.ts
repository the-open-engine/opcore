import type { CommandOwner, CommandRouteStatus } from "../command/vocabulary.js";
import type { releaseCutoverNegativeCheckIds } from "./vocabulary-01.js";

type ReleaseCutoverNegativeCheckId = (typeof releaseCutoverNegativeCheckIds)[number];

export type { ReleaseCutoverNegativeCheckId };

const releaseCutoverInputIssues = ["#17", "#29", "#58"] as const;

export { releaseCutoverInputIssues };

type ReleaseCutoverInputIssue = (typeof releaseCutoverInputIssues)[number];

export type { ReleaseCutoverInputIssue };

const aspDogfoodUnsupportedSurfaceIds = ["inspect", "edit"] as const;

export { aspDogfoodUnsupportedSurfaceIds };

type AspDogfoodUnsupportedSurfaceId = (typeof aspDogfoodUnsupportedSurfaceIds)[number];

export type { AspDogfoodUnsupportedSurfaceId };

const aspDogfoodForbiddenProviderMarkers = ["opcore asp serve", "opcore asp"] as const;

export { aspDogfoodForbiddenProviderMarkers };

type AspDogfoodForbiddenProviderMarker = (typeof aspDogfoodForbiddenProviderMarkers)[number];

export type { AspDogfoodForbiddenProviderMarker };

const releaseCutoverRequestFilePlaceholder = "<request-file>";

export { releaseCutoverRequestFilePlaceholder };

const releaseCutoverMissingGraphRepoPlaceholder = "<missing-graph-repo>";

export { releaseCutoverMissingGraphRepoPlaceholder };

const releaseCutoverRequiredGraphRequestPlaceholder = "<required-graph-request>";

export { releaseCutoverRequiredGraphRequestPlaceholder };

type ReleaseCutoverExpectedCommandStatus = CommandRouteStatus;

export type { ReleaseCutoverExpectedCommandStatus };

interface ReleaseCutoverCommandExpectation {
  readonly canonicalCommand: readonly string[];
  readonly requestFileBasename?: string;
  readonly owner: CommandOwner;
  readonly status: ReleaseCutoverExpectedCommandStatus;
  readonly exitCode: 0 | 1 | 2 | 64;
  readonly bin: "opcore";
}

export type { ReleaseCutoverCommandExpectation };
