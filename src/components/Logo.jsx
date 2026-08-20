import React from "react";

// InfinityCore brand logo (mirrors the Base44 version).
// variant: "full" (light bg) | "light" (dark bg).

export default function Logo({ size = 40, showText = true, showTagline = false, variant = "full", className = "" }) {
  const infinityColor = variant === "light" ? "#ffffff" : "#007a4a";
  const coreColor = "#f58220";
  const taglineColor = variant === "light" ? "rgba(255,255,255,0.65)" : "#333333";
  return (
    <div className={`flex flex-col items-center ${className}`}>
      <div className="flex items-center gap-2.5">
        <InfinityIcon size={size} />
        {showText && (
          <span className="font-bold tracking-tight leading-none" style={{ color: infinityColor, fontSize: size * 0.42 }}>
            Infinity<span style={{ color: coreColor }}>Core</span>
          </span>
        )}
      </div>
      {showTagline && (
        <div className="flex items-center gap-2 mt-1.5">
          <span className="block h-px w-6" style={{ backgroundColor: "#007a4a" }} />
          <span className="text-[10px] tracking-wide whitespace-nowrap" style={{ color: taglineColor }}>
            Powering Every Decision.
          </span>
          <span className="block h-px w-6" style={{ backgroundColor: "#f58220" }} />
        </div>
      )}
    </div>
  );
}

function InfinityIcon({ size = 40 }) {
  const id = "ic-green-grad";
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="InfinityCore">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#00a85a" />
          <stop offset="100%" stopColor="#007a4a" />
        </linearGradient>
      </defs>
      <g transform="rotate(45 50 50)">
        <rect x="21" y="19" width="58" height="58" rx="15" fill="#f58220" />
      </g>
      <g transform="rotate(45 50 50)">
        <rect x="24" y="24" width="52" height="52" rx="13" fill={`url(#${id})`} />
      </g>
      <text x="50" y="51" textAnchor="middle" dominantBaseline="central" fontSize="30" fontWeight="700" fill="#ffffff" fontFamily="ui-sans-serif, system-ui, sans-serif">∞</text>
      <g transform="rotate(45 63 50)">
        <rect x="60" y="47" width="6" height="6" fill="#f58220" />
      </g>
    </svg>
  );
}