import type { PortalAnimTrack } from '../portal-anim-timeline';
import type { PortalBundle } from '../portal-export';

type PortalJson = PortalBundle['portals'][number];

// An annotation as the exported viewer's settings document carries it: the
// union of the fields the export-time injectors read.
type AnnotationJson = {
    title?: string;
    text?: string;
    extras?: {
        id?: string;
        scene?: number;
        url?: string;
        newTab?: boolean;
        images?: { src: string; caption: string }[];
        i18n?: Record<string, { title?: string; text?: string; url?: string; captions?: string[] }>;
    };
};

// The exported viewer's settings document (settings.json) as the fork's export
// injectors read it. It is assembled as plain JSON, so only the fields the
// injectors touch are named; every other field passes through untouched.
type ViewerSettingsJson = {
    annotations?: AnnotationJson[];
    animTracks?: PortalAnimTrack[];
    background?: { color?: number[] };
    cameras?: { initial?: { position?: number[] } }[];
    offLimitsZones?: {
        position: [number, number, number];
        rotation: [number, number, number, number];
        width: number;
        height: number;
        infinite?: { top: boolean; right: boolean; bottom: boolean; left: boolean };
    }[];
    offLimitsMessage?: string;
    // transition is absent on documents written before the transition setting
    portals?: (Omit<PortalJson, 'transition'> & { transition?: PortalJson['transition'] })[];
    portalScenes?: string[];
    portalStart?: number;
    portalCollision?: (string | null)[];
    portalEnvironments?: string[];
    portalSceneLodCounts?: number[][];
    [key: string]: unknown;
};

export type { AnnotationJson, ViewerSettingsJson };
