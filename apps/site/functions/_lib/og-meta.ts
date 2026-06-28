/**
 * Shared OG-poster metadata re-export for Pages functions. The implementation
 * lives in @ax/lib so CLI surfaces can use the same cache-busting revision.
 */
export {
    OG_RENDER_REV,
    buildOgImageUrl,
    buildProfileOgImageUrl,
    ogImageVersion,
} from "@ax/lib/shared/og-meta";
export { OG_RENDER_REV as OG_PROFILE_RENDER_REV } from "@ax/lib/shared/og-meta";
