export function normalizeStepNumericExponents(stepText: string): string {
  return stepText.replace(
    /'[^'\n]*(?:''[^'\n]*)*'|(-?(?:\d+\.\d*|\.\d+|\d+))e([+-]?\d+)/g,
    (match, mantissa: string | undefined, exponent: string | undefined) =>
      mantissa === undefined ? match : `${mantissa}E${exponent}`,
  )
}
