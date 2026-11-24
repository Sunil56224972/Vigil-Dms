import React from 'react';

interface OdometerValueProps {
  value: string | number;
  suffix?: string;
  color?: string;
  fontSize?: number | string;
}

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export const OdometerValue: React.FC<OdometerValueProps> = ({
  value,
  suffix,
  color,
  fontSize,
}) => {
  const str = String(value);

  return (
    <span
      className="mono"
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        fontSize: fontSize || 'inherit',
        color: color || 'inherit',
        fontWeight: 600,
        lineHeight: 1.2,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'flex-start',
          height: '1.2em',
          overflow: 'hidden',
        }}
      >
        {Array.from(str).map((ch, idx) => {
          const num = ch >= '0' && ch <= '9' ? Number(ch) : null;
          if (num === null) {
            return (
              <span key={`${idx}-sym`} style={{ display: 'inline-block', lineHeight: '1.2em' }}>
                {ch}
              </span>
            );
          }
          return (
            <span
              key={idx}
              style={{
                display: 'inline-flex',
                flexDirection: 'column',
                lineHeight: '1.2em',
                transform: `translate3d(0, -${num * 1.2}em, 0)`,
                transition: 'transform 0.38s cubic-bezier(0.22, 1, 0.36, 1)',
                willChange: 'transform',
              }}
            >
              {DIGITS.map((d) => (
                <span key={d} style={{ height: '1.2em', display: 'block', textAlign: 'center' }}>
                  {d}
                </span>
              ))}
            </span>
          );
        })}
      </span>
      {suffix && <span className="readout-unit">{suffix}</span>}
    </span>
  );
};
