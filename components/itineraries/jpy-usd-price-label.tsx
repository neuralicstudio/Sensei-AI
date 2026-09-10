"use client";

import { formatJpyUsdPriceLine, useFxUsdJpy } from "@/hooks/use-fx-usd-jpy";

type Props = {
  jpy: number | null | undefined;
  className?: string;
};

/** US$493 — USD estimate only (JPY is never shown alongside USD). */
export function JpyUsdPriceLabel({ jpy, className }: Props) {
  const fx = useFxUsdJpy();
  const line = formatJpyUsdPriceLine(jpy, fx);

  if (!line) return null;

  return (
    <span className={className} title={line.title ?? undefined}>
      {line.label}
    </span>
  );
}

/** Agent catalog / modal: USD estimate, or em dash when price is missing. */
export function AdvisorUsdOrDash({
  jpy,
  className,
}: {
  jpy: number | null | undefined;
  className?: string;
}) {
  if (jpy == null || !Number.isFinite(Number(jpy))) return <>—</>;
  return <JpyUsdPriceLabel jpy={Number(jpy)} className={className} />;
}
