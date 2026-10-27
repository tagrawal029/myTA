// Math the way a person reads it. The models sometimes write LaTeX ("\Omega", "x^{2}", "\frac{a}{b}") or ASCII stand-ins ("x^2",
// "sqrt(2)", "<=", "10 ohms"): on screen that should be Ω, x², √2, ≤ and 10 Ω. Applied to everything tanrushu shows; it only changes how
// symbols look, never what is said.

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι',
  kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ',
  psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

const SYMBOLS: Record<string, string> = {
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡',
  sim: '∼', propto: '∝', infty: '∞', partial: '∂', nabla: '∇', int: '∫', oint: '∮', sum: 'Σ', prod: 'Π', degree: '°', circ: '°',
  to: '→', rightarrow: '→', Rightarrow: '⇒', leftarrow: '←', leftrightarrow: '↔', Leftrightarrow: '⇔', implies: '⇒', angle: '∠',
  perp: '⊥', parallel: '∥', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃',
  neg: '¬', land: '∧', lor: '∨', ldots: '…', cdots: '⋯', dots: '…', ohm: 'Ω', Ohm: 'Ω', hbar: 'ℏ', ell: 'ℓ', prime: '′', checkmark: '✓',
  quad: ' ', qquad: '  ', ',': ' ', ';': ' ', '!': '', ' ': ' ',
};

const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼',
  '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', x: 'ˣ', y: 'ʸ', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', j: 'ʲ', k: 'ᵏ',
  l: 'ˡ', m: 'ᵐ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', z: 'ᶻ', T: 'ᵀ', '*': '*', '′': '′',
};
const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍',
  ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

/** Superscript or subscript a short run, or null when a character has no small form (then it stays as "^(…)" / "_…", still readable). */
function small(run: string, map: Record<string, string>): string | null {
  let out = '';
  for (const ch of run) {
    const m = map[ch];
    if (m === undefined) return null;
    out += m;
  }
  return out;
}

/** The contents of a {…} group starting at `open` (the index of "{"), and the index after its "}". Nested groups are kept whole. */
function group(s: string, open: number): [string, number] | null {
  if (s[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return [s.slice(open + 1, i), i + 1];
  }
  return null;
}

/** Wraps in parentheses unless it is a single number, letter or symbol (so "\frac{a+b}{2}" reads "(a+b)/2", and "\frac{1}{2}" "1/2"). */
const paren = (x: string) => (/^[\p{L}\p{N}.′]+$/u.test(x) || /^\(.*\)$/.test(x) ? x : `(${x})`);

/** \frac{a}{b}, \sqrt{x}, \text{...} and friends: the commands with {…} arguments, innermost first. */
function commandsWithGroups(s: string): string {
  for (let guard = 0; guard < 50; guard++) {
    const m = /\\(d?frac|tfrac|sqrt|text|mathrm|mathbf|mathit|operatorname|vec|hat|bar|overline|left|right)\s*(\[[^\]]*\])?\s*(?=\{|[([|.)\]])/.exec(s);
    if (!m) break;
    const at = m.index;
    let after = at + m[0].length;
    const name = m[1];
    if (name === 'left' || name === 'right') {
      s = s.slice(0, at) + s.slice(after).replace(/^\./, '');
      continue;
    }
    const a = group(s, after);
    if (!a) {
      s = s.slice(0, at) + s.slice(after);
      continue;
    }
    after = a[1];
    let out: string;
    if (name.endsWith('frac')) {
      const b = group(s, after);
      if (!b) {
        out = a[0];
      } else {
        out = `${paren(commandsWithGroups(a[0]))}/${paren(commandsWithGroups(b[0]))}`;
        after = b[1];
      }
    } else if (name === 'sqrt') {
      const root = m[2]?.slice(1, -1);
      const inner = commandsWithGroups(a[0]);
      const radical = root === '3' ? '∛' : root === '4' ? '∜' : root ? `${root}√` : '√';
      out = `${radical}${paren(inner)}`;
    } else if (name === 'vec') out = `${a[0]}⃗`;
    else if (name === 'hat') out = `${a[0]}̂`;
    else if (name === 'bar' || name === 'overline') out = `${a[0]}̄`;
    else out = a[0];
    s = s.slice(0, at) + out + s.slice(after);
  }
  return s;
}

/** x^2 → x², x^{-1} → x⁻¹, v_0 → v₀, R_{th} → Rₜₕ. A run with no small form keeps a readable "^(…)". */
function scripts(s: string): string {
  const one = (text: string, mark: '^' | '_', map: Record<string, string>) =>
    text.replace(new RegExp(`\\${mark}(\\{([^{}]*)\\}|\\(([^()]{1,12})\\)|([−-]?[0-9]+|[A-Za-z*′]))`, 'g'), (_all, _g, braced, parened, bare) => {
      const run = (braced ?? parened ?? bare ?? '').replace(/\s+/g, '');
      const sm = small(run, map);
      if (sm !== null && run) return sm;
      return mark === '^' ? `^(${run})` : `_${run}`;
    });
  return one(one(s, '^', SUP), '_', SUB);
}

/** Readable math, with `code in backticks` left exactly as written (there, x^2, -> and * mean what they say). */
export function readable(text: string): string {
  if (!text) return text;
  return text
    .split(/(`[^`]*`)/)
    .map((part) => (part.length > 1 && part.startsWith('`') && part.endsWith('`') ? part : readablePart(part)))
    .join('');
}

function readablePart(text: string): string {
  let s = text;
  // Python-style powers: x**2 → x^2 (made small below). Before bold, or "x**2 + y**3" would read as bold.
  s = s.replace(/(\w|\))\*\*(\(?-?\w+\)?)/g, '$1^$2');
  // Markdown emphasis the bubble can't show: **word** → word.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  // Math-mode delimiters: $…$, $$…$$, \( … \), \[ … \].
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, '$1').replace(/\$([^$\n]{1,200})\$/g, '$1');
  s = s.replace(/\\\(|\\\)|\\\[|\\\]/g, '');
  s = commandsWithGroups(s);
  // Named commands: \Omega, \times, \to… A Greek letter followed by a one-letter symbol is one quantity ("\Delta V" → ΔV, "\mu s" → μs).
  s = s.replace(/\\([A-Za-z]+) ([A-Za-z])(?![A-Za-z])/g, (all, name: string, next: string) => (GREEK[name] ? `${GREEK[name]}${next}` : all));
  s = s.replace(/\\([A-Za-z]+|[,;! ])/g, (_all, name: string) => GREEK[name] ?? SYMBOLS[name] ?? (/^[A-Za-z]+$/.test(name) ? name : ''));
  s = s.replace(/\^\s*\{\s*°\s*\}|\^\s*°/g, '°').replace(/\^\s*\{\s*\\?circ\s*\}/g, '°');
  s = scripts(s);
  // Units written out, or with a slash or backslash in front: "10 ohms", "/ohm", "kohms" → 10 Ω, kΩ.
  s = s.replace(/([0-9.]\s*)(k|M|m)?\s*[/\\]?ohms?\b/gi, (_a, n: string, p: string | undefined) => `${n}${p ? (p === 'K' ? 'k' : p) : ''}Ω`);
  s = s.replace(/(^|[\s(=])[/\\]ohms?\b/gi, '$1Ω');
  s = s.replace(/\b(k|M)ohms?\b/g, '$1Ω');
  s = s.replace(/\b(\d+(?:\.\d+)?)\s*(?:degrees?|deg)\b(?!\s*(?:of|to)\b)/gi, '$1°');
  s = s.replace(/\bmicro(amps?|farads?|seconds?|meters?)\b/gi, (_a, u: string) => `μ${u}`);
  // ASCII stand-ins.
  s = s.replace(/\bsqrt\s*\(/g, '√(').replace(/\bsqrt\s*(\d+(?:\.\d+)?)/g, '√$1');
  s = s.replace(/<=>/g, '⇔').replace(/<=/g, '≤').replace(/>=/g, '≥').replace(/!=/g, '≠').replace(/=>/g, '⇒').replace(/->/g, '→').replace(/\+\/-|\+-(?=\s*\d)/g, '±');
  s = s.replace(/(\d)\s*\*\s*(?=[\d(])/g, '$1 × ').replace(/(\w|\))\s*\*\s*(?=\w|\()/g, '$1·');
  s = s.replace(/\binfinity\b/gi, '∞');
  // Leftover braces from markup and stray backslashes.
  s = s.replace(/(^|[^\\])[{}]/g, '$1').replace(/\\(?=[^A-Za-z]|$)/g, '');
  return s.replace(/[ \t]{2,}/g, ' ');
}
