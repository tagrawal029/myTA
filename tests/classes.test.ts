import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeTopics, migrateCourse, newClass, normalizeClass, resolveClass, titleMatches, toCourse, upsertClass, type ClassInfo } from '../src/core/shared/classes';
import { SettingsStore } from '../src/main/settings';

const cls = (name: string, o: Partial<ClassInfo> = {}): ClassInfo => ({ ...newClass(name, []), id: name, topics: ['x'], ...o });

describe('classes', () => {
  const calc = cls('Calc I', { topics: ['limits', 'chain rule'] });
  const calc2 = cls('Calc II', { topics: ['integrals'] });
  const circuits = cls('Circuits', { keywords: ['ECE 302', 'EE'], topics: ['KCL'] });
  const all = [calc, calc2, circuits];

  it('on Auto, picks the class named in the notes window title', () => {
    expect(resolveClass(all, 'auto', 'Calc I - week 5 - OneNote')?.name).toBe('Calc I');
    expect(resolveClass(all, 'auto', 'Calc II homework.pdf - Adobe Acrobat')?.name).toBe('Calc II');
    expect(resolveClass(all, 'auto', 'Lab 3 ECE 302 - Notion')?.name).toBe('Circuits');
    expect(resolveClass(all, 'auto', 'Untitled - Paint')).toBeNull();
    // Whole words only: "Calc III" isn't "Calc I", and "EE" isn't the "ee" in "week".
    expect(resolveClass([calc], 'auto', 'Calc III - OneNote')).toBeNull();
    expect(titleMatches(circuits, 'week 4 notes')).toBe(false);
  });

  it('a class picked by hand wins, and "none" turns the limits off', () => {
    expect(resolveClass(all, circuits.id, 'Calc I - OneNote')?.name).toBe('Circuits');
    expect(resolveClass(all, 'none', 'Calc I - OneNote')).toBeNull();
    expect(resolveClass(all, 'gone', 'Calc I')).toBeNull();
  });

  it('gives the model calls the topics, and nothing for a class without topics', () => {
    expect(toCourse(calc)).toMatchObject({ course: 'Calc I', topics: ['limits', 'chain rule'] });
    expect(toCourse({ ...calc, topics: [] })).toBeNull();
    expect(toCourse(null)).toBeNull();
  });

  it('merges syllabus topics without repeats, keeping yours first', () => {
    expect(mergeTopics(['limits', 'Chain rule'], ['Limits', 'chain rule', 'related rates'])).toEqual(['limits', 'Chain rule', 'related rates']);
  });

  it('tidies what setup sends', () => {
    const c = normalizeClass({ id: 'a', name: '  Physics   1 ', color: 'red', topics: ['kinematics', 'Kinematics', '', 5 as unknown as string], keywords: ['phys'] }, 9);
    expect(c).toMatchObject({ name: 'Physics 1', color: '#c0573f', topics: ['kinematics'], keywords: ['phys'], updatedAt: 9 });
    expect(upsertClass([calc], { ...calc, name: 'Calculus I' })).toHaveLength(1);
    expect(upsertClass([calc], calc2)).toHaveLength(2);
  });

  it('moves topics saved before classes existed into the first class', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myta-'));
    try {
      const file = join(dir, 'settings.json');
      writeFileSync(file, JSON.stringify({ course: { course: 'Calculus I', coveredUpTo: 'week 6', topics: ['limits'], updatedAt: 1 } }));
      const s = new SettingsStore(file, { available: () => false, encrypt: (x) => x, decrypt: (x) => x });
      expect(s.raw.classes).toHaveLength(1);
      expect(s.raw.classes[0]).toMatchObject({ name: 'Calculus I', coveredUpTo: 'week 6', topics: ['limits'] });
      expect(s.raw.activeClass).toBe('auto');
      expect(migrateCourse(null)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
