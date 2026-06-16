export function SplitBar({ segs }: { segs: { label: string; value: number; color: string }[] }) {
  const total = segs.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div style={{ display: "flex", width: "100%", height: 26, borderRadius: 4, overflow: "hidden" }}>
      {segs.map((s) => (
        <div key={s.label} title={`${s.label}: ${(100 * s.value / total).toFixed(1)}%`}
          style={{ width: `${(100 * s.value / total).toFixed(2)}%`, background: s.color }} />
      ))}
    </div>
  );
}
export function BarRow({ label, value, max, sub, color = "#888" }: { label: string; value: number; max: number; sub?: string; color?: string }) {
  return (
    <div style={{ margin: "6px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}><span>{label}</span><span style={{ opacity: 0.7 }}>{sub}</span></div>
      <div style={{ height: 8, background: "#2a2a2a" }}>
        <div style={{ width: `${Math.max(2, 100 * value / (max || 1)).toFixed(1)}%`, height: 8, background: color }} />
      </div>
    </div>
  );
}
