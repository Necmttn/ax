// "Starred by engineers from" logo carousel for the landing page.
// Real GitHub stargazers' orgs, logos only. Inline SVG / text wordmarks only
// (no <img>, no CORS, no external dep). Everything is monochrome via
// currentColor so the marquee reads as one quiet logo wall, not a pile of
// brand colors. The track is duplicated so the scroll loops seamlessly.

type Mark =
  | { kind: "glyph"; node: React.ReactNode }
  | { kind: "wordmark"; text: string };

type Logo = { key: string; company: string; mark: Mark };

const CloudflareGlyph = (
  // simpleicons.org/cloudflare
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727"
    />
  </svg>
);

const AppleGlyph = (
  // simpleicons.org/apple
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"
    />
  </svg>
);

const SuperwallGlyph = (
  // superwall.com/assets/favicon.svg - "SW" monogram, recolored to currentColor
  // and viewBox tightened to the mark bounds (= the source clip rect).
  <svg viewBox="7 12 33 24" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M15.268 34.5403C15.4367 34.5403 15.5708 34.4905 15.6705 34.3908C15.7702 34.2912 15.82 34.157 15.82 33.9883V32.3783C17.4453 32.2097 18.7372 31.7113 19.6955 30.8833C20.6538 30.0553 21.133 28.9743 21.133 27.6403C21.133 26.7357 20.9413 25.992 20.558 25.4093C20.1747 24.8267 19.5805 24.3437 18.7755 23.9603C17.9705 23.577 16.8857 23.232 15.521 22.9253C14.5397 22.68 13.7845 22.45 13.2555 22.2353C12.7265 22.0207 12.3432 21.7753 12.1055 21.4993C11.8678 21.2233 11.749 20.8783 11.749 20.4643C11.749 19.851 11.9905 19.3833 12.4735 19.0613C12.9565 18.7393 13.6197 18.5783 14.463 18.5783C15.2297 18.5783 15.8698 18.7432 16.3835 19.0728C16.8972 19.4025 17.2 19.8127 17.292 20.3033C17.4147 20.5793 17.637 20.7173 17.959 20.7173H20.144C20.282 20.7173 20.397 20.6713 20.489 20.5793C20.581 20.4873 20.627 20.3723 20.627 20.2343C20.5963 19.667 20.3932 19.0843 20.0175 18.4863C19.6418 17.8883 19.0975 17.3632 18.3845 16.9108C17.6715 16.4585 16.8167 16.1633 15.82 16.0253V14.3923C15.82 14.2237 15.7702 14.0895 15.6705 13.9898C15.5708 13.8902 15.4367 13.8403 15.268 13.8403H13.842C13.6887 13.8403 13.5583 13.8902 13.451 13.9898C13.3437 14.0895 13.29 14.2237 13.29 14.3923V15.9793C11.7873 16.1633 10.6028 16.6693 9.7365 17.4973C8.87017 18.3253 8.437 19.3373 8.437 20.5333C8.437 21.852 8.85867 22.864 9.702 23.5693C10.5453 24.2747 11.8717 24.842 13.681 25.2713C14.7697 25.5627 15.5938 25.8118 16.1535 26.0188C16.7132 26.2258 17.131 26.4673 17.407 26.7433C17.683 27.0193 17.821 27.3643 17.821 27.7783C17.821 28.407 17.5488 28.9015 17.0045 29.2618C16.4602 29.6222 15.659 29.8023 14.601 29.8023C13.6503 29.8023 12.9028 29.626 12.3585 29.2733C11.8142 28.9207 11.4577 28.4837 11.289 27.9623C11.197 27.809 11.1012 27.6978 11.0015 27.6288C10.9018 27.5598 10.76 27.5253 10.576 27.5253H8.506C8.368 27.5253 8.24917 27.5752 8.1495 27.6748C8.04983 27.7745 8 27.8857 8 28.0083C8.03067 28.7137 8.24917 29.3768 8.6555 29.9978C9.06183 30.6188 9.65983 31.144 10.4495 31.5733C11.2392 32.0027 12.186 32.271 13.29 32.3783V33.9883C13.29 34.157 13.3437 34.2912 13.451 34.3908C13.5583 34.4905 13.6887 34.5403 13.842 34.5403H15.268Z"
    />
    <path
      fill="currentColor"
      d="M28.2794 29.2404C28.6934 29.2404 28.9617 29.0487 29.0844 28.6654L31.6604 21.0294L34.2364 28.6654C34.2824 28.8187 34.3744 28.9529 34.5124 29.0679C34.6504 29.1829 34.8267 29.2404 35.0414 29.2404H36.6054C36.8354 29.2404 37.0232 29.179 37.1689 29.0564C37.3146 28.9337 37.4027 28.765 37.4334 28.5504L40.1474 13.8074C40.1627 13.7614 40.1704 13.7 40.1704 13.6234C40.1704 13.4854 40.1244 13.3704 40.0324 13.2784C39.9404 13.1864 39.8331 13.1404 39.7104 13.1404H37.6404C37.2571 13.1404 37.0424 13.2937 36.9964 13.6004L35.1104 23.9504L33.0404 17.2804C32.9944 17.127 32.9101 16.9929 32.7874 16.8779C32.6647 16.7629 32.5037 16.7054 32.3044 16.7054H31.0394C30.6867 16.7054 30.4337 16.897 30.2804 17.2804L28.2334 23.9504L26.3244 13.6004C26.2937 13.4317 26.2324 13.3129 26.1404 13.2439C26.0484 13.1749 25.9027 13.1404 25.7034 13.1404H23.6334C23.4954 13.1404 23.3804 13.1864 23.2884 13.2784C23.1964 13.3704 23.1504 13.4854 23.1504 13.6234L23.1734 13.8074L25.8874 28.5504C25.9947 29.0104 26.2707 29.2404 26.7154 29.2404H28.2794Z"
    />
  </svg>
);

const TrustlyGlyph = (
  // trustly.com favicon - geometric "T" with the right-pointing arrow notch,
  // traced from the brand mark; viewBox tightened to the glyph bounds.
  <svg viewBox="23 49 208 156" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M23 49 L231 49 L231 113 L166 113 L166 205 L96 205 L96 181 L151 118 L98 61 L95 113 L23 113 Z"
    />
  </svg>
);

const LOGOS: Logo[] = [
  { key: "cloudflare", company: "Cloudflare", mark: { kind: "glyph", node: CloudflareGlyph } },
  { key: "apple", company: "Apple", mark: { kind: "glyph", node: AppleGlyph } },
  { key: "segment", company: "Segment", mark: { kind: "wordmark", text: "Segment" } },
  { key: "superwall", company: "Superwall", mark: { kind: "glyph", node: SuperwallGlyph } },
  { key: "trustly", company: "Trustly", mark: { kind: "glyph", node: TrustlyGlyph } },
];

function LogoItem({ logo }: { logo: Logo }) {
  return (
    <li className={`used-by-item used-by-item--${logo.key}`} title={logo.company}>
      {logo.mark.kind === "glyph" ? (
        <span className="used-by-glyph" aria-hidden="true">{logo.mark.node}</span>
      ) : (
        <span className="used-by-wordmark">{logo.mark.text}</span>
      )}
    </li>
  );
}

// One full copy of the logo list. min-width:100% (in CSS) makes each copy fill
// the viewport, so the marquee never exposes a gap. The canonical Ryan Mulligan
// pattern renders this twice and animates each copy by exactly -100% - gap.
function MarqueeCopy({ dup }: { dup?: boolean }) {
  return (
    <ul className="used-by-group" role="list" aria-hidden={dup}>
      {LOGOS.map((logo) => (
        <LogoItem key={`${dup ? "b" : "a"}-${logo.key}`} logo={logo} />
      ))}
    </ul>
  );
}

export function UsedByStrip() {
  return (
    <section className="used-by" aria-labelledby="used-by-title">
      <p className="used-by-caption" id="used-by-title">Used by engineers from</p>

      <div className="used-by-marquee" role="group" aria-label="Companies whose engineers starred ax">
        <MarqueeCopy />
        <MarqueeCopy dup />
      </div>
    </section>
  );
}
