import { PREPARED_SCENARIOS, rawOpinion } from "../src/index";
import type { CheckerFlag, CheckerOpinion, CheckerReport, GeneratedOpinion, RawOpinion } from "../src/index";

/** The first prepared scenario as a scenario-only input (numbered evidence e1..e6, no interpretations). */
export const scenario = PREPARED_SCENARIOS[0];

/** Five different readings (by title) and one paraphrase of the first with different wording. */
export const READINGS = {
  outsider: { title: "Outsider on impulse", explanation: "A visitor who stayed hidden after closing used a spare key to open the case and took the painting on impulse, tripping the alarm while slipping out." },
  staged: { title: "Staged for insurance", explanation: "Someone planned the theft to support a later insurance claim, opened the case, removed the painting and set off the alarm deliberately to leave an official record." },
  loan: { title: "Unlogged loan move", explanation: "No theft occurred: the painting was removed for the pending loan by a person who did not log the move, and the alarm was tripped by accident during it." },
  insider: { title: "Insider, private motive", explanation: "A staff member removed the painting for private reasons such as sentiment or a private sale, using their own key around the guard's rounds, with no insurance link." },
  maintenance: { title: "Sensor and wiring fault", explanation: "A fault in the case sensor wiring created a false opening and alarm record, and the painting was taken afterwards by whoever found the case unattended." },
  outsiderParaphrase: { title: "Hidden visitor", explanation: "Somebody concealed in the building after closing time grabbed a spare key, opened the display case on a whim and sounded the alarm while sneaking away." },
  outsiderParaphrase2: { title: "Concealed intruder", explanation: "An intruder who had slipped in unseen before closing and kept out of sight later forced nothing, picked up a key and lifted the picture from its case before the alarm sounded." },
  employeeTook: { title: "An employee stole it", explanation: "An employee deliberately took the painting from the display case for personal gain, using their staff access outside working hours." },
  guardTook: { title: "A guard stole it", explanation: "The night guard secretly removed the painting from the case on purpose, using the keys and rounds that come with the guard's job." },
  staffTook: { title: "Staff member took it", explanation: "A member of staff quietly took the painting for themselves, relying on their authorised access to the gallery after hours." },
  rival: { title: "Rival collector's agent", explanation: "An agent working for a rival collector arranged the removal of the painting through a bribed contractor whose access was never recorded." },
};
export type Key = keyof typeof READINGS;

/** Opinions of one agent from reading keys, ranked in the given order (rank 1,2,3) with the given self-scores. */
export function opinionsFor(side: "A" | "B", keys: [Key, Key, Key], scores: [number, number, number] = [80, 66, 52]): GeneratedOpinion[] {
  return keys.map((k, i) => ({ ...rawOpinion(READINGS[k].title, READINGS[k].explanation, i + 1, scores[i]), id: `${side}${i + 1}`, side }));
}
export const raws = (keys: [Key, Key, Key], scores: [number, number, number] = [80, 66, 52]): RawOpinion[] => keys.map((k, i) => rawOpinion(READINGS[k].title, READINGS[k].explanation, i + 1, scores[i]));

export type Spec = Partial<Record<Key, { defensibility?: number; flag?: CheckerFlag }>>;

/** A checker report computed from CONTENT only (so shuffles and label swaps cannot change it): the same title always gets the same verdict. */
export function contentReport(opinions: CheckerOpinion[], spec: Spec = {}, sameGroups: Key[][] = [["outsider", "outsiderParaphrase"]], cosmetic: [Key, Key][] = []): CheckerReport {
  const keyOf = (o: CheckerOpinion) => (Object.keys(READINGS) as Key[]).find((k) => READINGS[k].title === o.title)!;
  const classOf = (o: CheckerOpinion) => { const g = sameGroups.findIndex((s) => s.includes(keyOf(o))); return g >= 0 ? `g${g}` : keyOf(o); };
  const byClass = new Map<string, string[]>();
  for (const o of opinions) byClass.set(classOf(o), [...(byClass.get(classOf(o)) ?? []), o.id]);
  const groups = [...byClass.values()].filter((g) => g.length >= 2);
  const inSame = (a: CheckerOpinion, b: CheckerOpinion) => classOf(a) === classOf(b);
  const isCosmetic = (a: CheckerOpinion, b: CheckerOpinion) => cosmetic.some(([x, y]) => (keyOf(a) === x && keyOf(b) === y) || (keyOf(a) === y && keyOf(b) === x));
  return {
    assessments: opinions.map((o) => ({ id: o.id, defensibility: spec[keyOf(o)]?.defensibility ?? 70, flag: spec[keyOf(o)]?.flag ?? "ok", note: "test assessment" })),
    equivalenceGroups: groups,
    pairs: opinions.flatMap((a, i) => opinions.slice(i + 1).map((b) => ({ a: a.id, b: b.id, difference: inSame(a, b) ? 8 : isCosmetic(a, b) ? 15 : 75, meaningful: !inSame(a, b) && !isCosmetic(a, b) }))),
  };
}
