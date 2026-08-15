export function timelineDecisionEvidence(selectionReason: string) {
  const pacingWeight = selectionReason.match(/pacing weight of\s+([0-9]+(?:\.[0-9]+)?)/i)?.[1];
  if (pacingWeight) return `Groq pacing ×${pacingWeight}`;
  if (/chronological script order/i.test(selectionReason)) return "Groq ordered source";
  return "Provider decision";
}
