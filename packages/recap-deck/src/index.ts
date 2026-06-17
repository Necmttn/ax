/** @ax/recap-deck - the single source of the nullframe "recap/wrapped" chart
 *  deck, shared by studio, the landing, and the profile page.
 *
 *  Styles ship separately as CSS (import once at the app shell):
 *    import "@ax/recap-deck/styles/recap-deck-theme.css"; // .rdx token scope
 *    import "@ax/recap-deck/styles/recap-deck.css";       // structural rules
 *  The deck must render inside an element scoped `.rdx` with a `data-theme`. */
export { CardViz, VIZ_KINDS, type VizKind, type VizSpec } from "./card-viz.tsx";
export { Doto, Segbar } from "./viz.tsx";
export { DeckCard, type DeckCardProps } from "./deck-card.tsx";
