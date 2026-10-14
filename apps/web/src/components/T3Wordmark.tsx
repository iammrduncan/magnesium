import { useId, type SVGProps } from "react";

// magnesium: the plain "Mg" square (D17) replaces T3's wordmark. The letters are
// cut out of the square, so the mark reads on any background.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  const maskId = useId();
  return (
    <svg {...props} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <mask id={maskId}>
        <rect width="24" height="24" fill="white" />
        <text
          x="12"
          y="16.2"
          textAnchor="middle"
          fontSize="11.5"
          fontWeight="700"
          letterSpacing="-0.3"
          fill="black"
        >
          Mg
        </text>
      </mask>
      <rect width="24" height="24" rx="5" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}
