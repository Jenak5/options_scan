export function kellyFraction(winProb: number, winAmount: number, lossAmount: number): number {
  if (lossAmount <= 0 || winProb <= 0 || winProb >= 1) return 0;
  const b = winAmount / lossAmount;
  const f = (winProb * b - (1 - winProb)) / b;
  return Math.max(0, Math.min(f, 1));
}

export function fractionalKelly(winProb: number, winAmount: number, lossAmount: number, fraction: number = 0.25): number {
  return kellyFraction(winProb, winAmount, lossAmount) * fraction;
}

export function kellyPositionSize(bankroll: number, winProb: number, winAmount: number, lossAmount: number, fraction: number = 0.25): number {
  return bankroll * fractionalKelly(winProb, winAmount, lossAmount, fraction);
}

export function expectedValue(winProb: number, winAmount: number, lossAmount: number): number {
  return winProb * winAmount - (1 - winProb) * lossAmount;
}

export function evGap(modelProb: number, marketImpliedProb: number, payout: number = 1): number {
  return (modelProb - marketImpliedProb) * payout;
}

export interface VolArbSignal {
  symbol: string; iv: number; rv20: number; rv10: number;
  spread: number; signal: "BUY_VOL" | "SELL_VOL" | "NEUTRAL"; strength: number;
}

export function analyzeVolArb(symbol: string, iv: number, rv20: number, rv10: number, threshold: number = 5): VolArbSignal {
  const spread = iv - rv20;
  let signal: VolArbSignal["signal"] = "NEUTRAL";
  if (spread > threshold) signal = "SELL_VOL";
  if (spread < -threshold) signal = "BUY_VOL";
  return { symbol, iv, rv20, rv10, spread, signal, strength: Math.min(Math.abs(spread) / 20, 1) };
}

export function kellyGrowthCurve(winProb: number, winLossRatio: number, steps: number = 50) {
  const points: Array<{ fraction: number; growth: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const g = winProb * Math.log(1 + f * winLossRatio) + (1 - winProb) * Math.log(Math.max(1 - f, 0.001));
    points.push({ fraction: Math.round(f * 100), growth: isFinite(g) ? g : -2 });
  }
  return points;
}
