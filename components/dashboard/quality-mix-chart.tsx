"use client";

import React from "react";
import type { QcClass } from "@/lib/qc/config";
import { round1 } from "@/lib/qc/metrics";

export function QualityMixChart({
  classes,
  pctByClass,
}: {
  classes: readonly QcClass[];
  pctByClass: Record<string, number>;
}) {
  const ticks = [100, 75, 50, 25, 0];

  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 15,
        background: "#ffffff",
        padding: "18px 20px 14px 20px",
        boxShadow: "0 2px 10px rgba(15, 23, 42, 0.03)",
      }}
      data-testid="quality-mix-chart"
    >
      <div
        style={{
          position: "relative",
          height: 240,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          paddingLeft: 42,
          paddingBottom: 32,
          paddingTop: 18,
        }}
      >
        {/* Horizontal grid lines */}
        {ticks.map((t) => (
          <div
            key={t}
            style={{
              position: "relative",
              borderBottom: "1px dashed #e2e8f0",
              width: "100%",
              height: 0,
            }}
          >
            <span
              style={{
                position: "absolute",
                left: -42,
                top: -8,
                width: 36,
                textAlign: "right",
                fontSize: 11,
                color: "#64748b",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {t}%
            </span>
          </div>
        ))}

        {/* Bars layer */}
        <div
          style={{
            position: "absolute",
            left: 42,
            right: 8,
            top: 18,
            bottom: 32,
            display: "grid",
            gridTemplateColumns: `repeat(${classes.length}, minmax(0, 1fr))`,
            gap: 18,
            alignItems: "end",
          }}
        >
          {classes.map((cls) => {
            const rawVal = pctByClass[cls.key] ?? 0;
            const val = round1(rawVal);
            const clampedHeight = Math.max(0, Math.min(100, val));
            return (
              <div
                key={cls.key}
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  position: "relative",
                }}
                data-testid={`mix-bar-${cls.key}`}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 800,
                    color: "#0f172a",
                    marginBottom: 4,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {val.toFixed(1)}%
                </div>
                <div
                  title={`${cls.label}: ${val.toFixed(1)}%`}
                  style={{
                    width: "68%",
                    maxWidth: 78,
                    height: `${Math.max(clampedHeight, val > 0 ? 2 : 0)}%`,
                    minHeight: val > 0 ? 4 : 2,
                    background: cls.color,
                    border: "1px solid rgba(15, 23, 42, 0.14)",
                    borderRadius: "8px 8px 2px 2px",
                    transition: "height 0.25s ease",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    bottom: -26,
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#334155",
                    textAlign: "center",
                    whiteSpace: "nowrap",
                  }}
                >
                  {cls.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ color: "#64748b", fontSize: 11, marginTop: 8 }}>
        Pooled count % across all active sample plates in the inspection window.
      </div>
    </div>
  );
}
