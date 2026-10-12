// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-1's light-only check: a colour property in a kit sheet holds tokens
// with a dark value, never a literal colour, which paints the same in both
// themes. A literal is a hex, a colour function or any of CSS's named colours.

type Sets = Readonly<Record<'light' | 'dark', Readonly<Record<string, string>>>>;

const COLOUR_PROPERTY =
  /^(color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-start|-end)?)?(-color)?|outline(-color)?|box-shadow|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?)$/u;
/** CSS's 148 named colours: each paints the same in both themes, as a hex literal does. */
const NAMED_COLOURS: ReadonlySet<string> = new Set(
  `
  aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
  blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue
  cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey
  darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
  darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet
  deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen
  fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
  hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon
  lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey
  lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey
  lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine
  mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen
  mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite
  navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen
  paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple
  rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell
  sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan
  teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen
  `
    .trim()
    .split(/\s+/u),
);
export const lightOnly = (
  sets: Sets,
  name: string,
  css: string,
  constant: ReadonlySet<string>,
): string[] => {
  const problems: string[] = [];
  const bare = css.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
  for (const match of bare.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/gu)) {
    const [, property = '', value = ''] = match;
    if (!COLOUR_PROPERTY.test(property)) continue;
    const where = `${name} ${property}: ${value.trim()}`;
    // A token or file name may hold a colour word (`var(--red)`); the words outside them may not.
    const words = value
      .replaceAll(/var\([^)]*\)|url\([^)]*\)/giu, ' ')
      .toLowerCase()
      .split(/[^a-z]+/u);
    if (
      /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(/iu.test(value) ||
      words.some((word) => NAMED_COLOURS.has(word))
    ) {
      problems.push(`literal colour in ${where}`);
    }
    for (const [, token = ''] of value.matchAll(/var\((--[\w-]+)/gu)) {
      if (sets.light[token] === undefined) problems.push(`undeclared ${token} in ${where}`);
      else if (sets.light[token] === sets.dark[token] && !constant.has(token)) {
        problems.push(`${token} has no dark value, in ${where}`);
      }
    }
  }
  return problems;
};
