import { describe, expect, it } from 'vitest';
import { readable } from '../src/core/shared/readableMath';

describe('math the way a person reads it', () => {
  it('turns LaTeX into symbols', () => {
    expect(readable('The resistor is 10 \\Omega and the angle is \\theta.')).toBe('The resistor is 10 Ω and the angle is θ.');
    expect(readable('$V = I \\times R$')).toBe('V = I × R');
    expect(readable('\\(x \\leq 3\\) and \\(y \\ne 0\\)')).toBe('x ≤ 3 and y ≠ 0');
    expect(readable('Try \\frac{1}{2} of \\frac{a+b}{c}')).toBe('Try 1/2 of (a+b)/c');
    expect(readable('\\sqrt{2} and \\sqrt{x+1} and \\sqrt[3]{8}')).toBe('√2 and √(x+1) and ∛8');
    expect(readable('\\text{the current } I_{1}')).toBe('the current I₁');
    expect(readable('\\left( a + b \\right)')).toBe('( a + b )');
    expect(readable('30^\\circ and 45^{\\circ}')).toBe('30° and 45°');
    expect(readable('\\Delta V \\approx 2 \\mu s')).toBe('ΔV ≈ 2 μs');
  });

  it('makes powers and subscripts small', () => {
    expect(readable('sin(3x^2)')).toBe('sin(3x²)');
    expect(readable('x^{-1} + e^{2x} + 10^3')).toBe('x⁻¹ + e²ˣ + 10³');
    expect(readable('v_0 and R_{th} and V_{CC}')).toBe('v₀ and Rₜₕ and V_CC');
    expect(readable('x**2 + y**(-1)')).toBe('x² + y⁻¹');
  });

  it('writes units the way they are printed', () => {
    expect(readable('a 10 ohm resistor and a 2 kohm one')).toBe('a 10 Ω resistor and a 2 kΩ one');
    expect(readable('R1 = 4/ohms')).toBe('R1 = 4Ω');
    expect(readable('R = 5 \\ohm')).toBe('R = 5 Ω');
    expect(readable('turn it 90 degrees')).toBe('turn it 90°');
    expect(readable('2 microfarads')).toBe('2 μfarads');
  });

  it('replaces ASCII stand-ins', () => {
    expect(readable('x <= 3, y >= 2, z != 1, a -> b')).toBe('x ≤ 3, y ≥ 2, z ≠ 1, a → b');
    expect(readable('sqrt(2) and sqrt 9')).toBe('√(2) and √9');
    expect(readable('3 * 4 and 2*x')).toBe('3 × 4 and 2·x');
    expect(readable('it is +/- 5')).toBe('it is ± 5');
  });

  it('leaves code in backticks, plain words and normal text alone', () => {
    expect(readable('Check `x = y ** 2 -> z` again')).toBe('Check `x = y ** 2 -> z` again');
    expect(readable("Look at your second line. What happens to the inside?")).toBe("Look at your second line. What happens to the inside?");
    expect(readable('**Hint:** use Ohm’s law')).toBe('Hint: use Ohm’s law');
    expect(readable('The degree of the polynomial')).toBe('The degree of the polynomial');
  });
});
