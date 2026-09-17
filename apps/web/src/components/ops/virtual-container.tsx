'use client';

/**
 * The virtual container — MODULE_CLP.md §5.1, asked for twice by the client.
 *
 * "A container outline filled left-to-right in proportion to volume used, one
 * colour band per PO with the PO number labelled on its band. The picture is
 * what makes an over-stuffed plan obvious at a glance."
 *
 * Two decisions worth stating, because both were choices rather than readings:
 *
 * The spec says "at the size's aspect ratio". Nothing in the schema records a
 * container's metres — only its volume and payload — so the outline is drawn
 * at a constant height with its WIDTH proportional to capacity. A 40HC (72
 * CBM) is therefore drawn two and a half times as long as a 20STD (28), which
 * is truthful about what the picture is for: two cards side by side compare
 * correctly, and a half-full 40HC does not look emptier than a full 20STD.
 * Real dimensions would need columns that do not exist; that is §11's business,
 * not something to guess at here.
 *
 * The colours are §12's own tokens — harbour, hull, verified, steel — cycled,
 * and never --alert. Alert means over capacity on this card, and a PO that
 * happened to be fifth in the list should not borrow the colour that means
 * trouble.
 */

export interface ContainerBand {
  poNo: string;
  volumeCbm: number;
}

/** §12 tokens only. --alert is reserved for the overflow. */
const BAND_TOKENS = [
  'var(--color-harbour)',
  'var(--color-hull)',
  'var(--color-verified)',
  'var(--color-steel)',
] as const;

function bandFill(index: number): { fill: string; opacity: number } {
  return {
    fill: BAND_TOKENS[index % BAND_TOKENS.length]!,
    // A second pass through the same four at lower weight, so a plan with
    // eight POs still reads as eight bands rather than four repeated.
    opacity: index < BAND_TOKENS.length ? 1 : 0.55,
  };
}

const num = (v: number, dp = 2): string =>
  v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function VirtualContainer({
  sizeCode,
  maxVolumeCbm,
  maxWeightKg,
  usedWeightKg,
  bands,
  widthFraction,
}: {
  sizeCode: string;
  /** Null where nobody recorded it — §4.2 must not read that as room to spare. */
  maxVolumeCbm: number | null;
  maxWeightKg: number | null;
  usedWeightKg: number;
  bands: ContainerBand[];
  /** This box's capacity against the largest on the plan, 0–1. */
  widthFraction: number;
}) {
  const used = bands.reduce((sum, b) => sum + b.volumeCbm, 0);

  if (maxVolumeCbm === null || maxVolumeCbm <= 0) {
    return (
      <p className="text-cell text-steel">
        No capacity recorded for {sizeCode}, so this plan cannot be checked against one. Set it
        on Settings → Container Size.
      </p>
    );
  }

  /*
    Geometry.

    The drawing is scaled to whichever is larger, the capacity or the load.
    When the load fits, that is the capacity and the box is drawn full width
    with the bands filling part of it. When it does not fit, the scale grows
    and the CONTAINER shrinks within it — so the cargo visibly runs past the
    end of the box, which is the whole point of the picture.

    The first version scaled to capacity alone. A 30.72 CBM load in a 28 CBM
    box then filled the entire width, the second PO was drawn at zero width,
    and the overflow marker landed outside the viewBox where nobody could see
    it. It looked full rather than over-full, which is exactly the mistake
    this drawing exists to prevent.
  */
  const VIEW_W = 320;
  const VIEW_H = 76;
  const PAD = 2;
  const LABEL_H = 14;
  const boxH = VIEW_H - PAD * 2 - LABEL_H;

  // How wide this size is drawn relative to the biggest box on the plan.
  const lane = (VIEW_W - PAD * 2) * Math.min(1, Math.max(0.3, widthFraction));
  const scale = Math.max(maxVolumeCbm, used);
  const capacityW = (maxVolumeCbm / scale) * lane;
  const fillRatio = used / maxVolumeCbm;
  const over = fillRatio > 1;

  let cursor = 0;
  const drawn = bands.map((band, index) => {
    const x = PAD + (cursor / scale) * lane;
    const w = (band.volumeCbm / scale) * lane;
    cursor += band.volumeCbm;
    return { ...band, x, w, ...bandFill(index) };
  });

  return (
    <figure className="flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full"
        role="img"
        aria-label={
          `${sizeCode} container, ${num(fillRatio * 100, 1)}% of ${num(maxVolumeCbm, 0)} CBM used` +
          (bands.length === 0 ? ', empty' : `, carrying ${bands.map((b) => b.poNo).join(', ')}`)
        }
      >
        {/* The box itself — only as far as its capacity reaches. */}
        <rect
          x={PAD}
          y={PAD}
          width={capacityW}
          height={boxH}
          rx={3}
          fill="var(--color-paper)"
          stroke={over ? 'var(--color-alert)' : 'var(--color-line)'}
          strokeWidth={1.5}
        />

        {drawn.map((band) => (
          <g key={band.poNo + band.x}>
            <rect
              x={band.x}
              y={PAD + 1}
              width={Math.max(0, band.w)}
              height={boxH - 2}
              fill={band.fill}
              opacity={band.opacity}
            />
            {band.w > 30 && (
              <text
                x={band.x + band.w / 2}
                y={PAD + boxH / 2 + 4}
                textAnchor="middle"
                fontSize="11"
                fill="var(--color-surface)"
              >
                {band.poNo}
              </text>
            )}
          </g>
        ))}

        {/*
          Everything past the container's end, tinted so the eye lands on it
          before it reads a single number.
        */}
        {over && (
          <>
            <rect
              x={PAD + capacityW}
              y={PAD + 1}
              width={lane - capacityW}
              height={boxH - 2}
              fill="var(--color-alert)"
              opacity={0.28}
            />
            <line
              x1={PAD + capacityW}
              y1={PAD - 1}
              x2={PAD + capacityW}
              y2={PAD + boxH + 1}
              stroke="var(--color-alert)"
              strokeWidth={2}
            />
          </>
        )}

        {/* The door end, so the drawing reads as a container, not a bar. */}
        {!over && (
          <line
            x1={PAD + capacityW - 6}
            y1={PAD + 3}
            x2={PAD + capacityW - 6}
            y2={PAD + boxH - 3}
            stroke="var(--color-line)"
            strokeWidth={1}
          />
        )}

        <text x={PAD} y={VIEW_H - 3} fontSize="10" fill="var(--color-steel)">
          {sizeCode} · {num(used, 2)} of {num(maxVolumeCbm, 0)} CBM
        </text>
        {over && (
          <text
            x={PAD + lane}
            y={VIEW_H - 3}
            textAnchor="end"
            fontSize="10"
            fill="var(--color-alert)"
          >
            {num(used - maxVolumeCbm, 2)} CBM will not fit
          </text>
        )}
      </svg>

      <Bar
        label="Volume"
        used={used}
        limit={maxVolumeCbm}
        unit="CBM"
        dp={2}
      />
      <Bar
        label="Weight"
        used={usedWeightKg}
        limit={maxWeightKg}
        unit="kg"
        dp={0}
      />

      {/*
        The legend carries every PO, including the bands too narrow to label.

        The share is against the container's CAPACITY, not against the load,
        so these percentages add up to the volume figure in the bar above —
        "88.8% + 7.9%" reads back as the 96.7% the box is filled to. Against
        the load they would always total 100% and say nothing about how full
        the container is, which is the question the picture exists to answer.
      */}
      {bands.length > 0 && (
        <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {drawn.map((band) => (
            <span key={`legend-${band.poNo}-${band.x}`} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 rounded-[2px]"
                style={{ backgroundColor: band.fill, opacity: band.opacity }}
              />
              <span className="font-mono text-cell tabular-nums text-hull">{band.poNo}</span>
              <span className="font-mono text-cell tabular-nums text-steel">
                {num(band.volumeCbm, 2)} CBM
              </span>
              <span aria-hidden="true" className="text-cell text-line">
                &middot;
              </span>
              <span className="font-mono text-cell tabular-nums text-hull">
                {num((band.volumeCbm / maxVolumeCbm) * 100, 1)}%
              </span>
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

/**
 * One utilisation bar — §5.1 wants the percentage AND what is left, because
 * "83%" does not tell a planner whether another pallet fits.
 */
function Bar({
  label,
  used,
  limit,
  unit,
  dp,
}: {
  label: string;
  used: number;
  limit: number | null;
  unit: string;
  dp: number;
}) {
  if (limit === null || limit <= 0) {
    return (
      <p className="text-cell text-steel">
        {label}: no limit recorded for this container size.
      </p>
    );
  }

  const ratio = used / limit;
  const pct = ratio * 100;
  // §4.2: exactly full is allowed and only above it is an exception — the
  // client plans a 20STD to exactly 28.0 CBM.
  const over = ratio > 1;
  const left = limit - used;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="label-manifest">{label}</span>
        <span
          className={
            over
              ? 'font-mono text-cell tabular-nums text-alert'
              : 'font-mono text-cell tabular-nums text-hull'
          }
        >
          {pct.toFixed(1)}%
          <span className="ml-2 text-steel">
            {over
              ? `${num(-left, dp)} ${unit} over`
              : `${num(left, dp)} ${unit} left`}
          </span>
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-[2px] bg-paper">
        <div
          className={over ? 'h-1.5 bg-alert' : 'h-1.5 bg-harbour'}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
    </div>
  );
}
