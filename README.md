# `dom-inline-style-filter`

<p align="center"><img src="https://github.com/zm-cttae/dom-inline-style-filter/raw/dddefaf96c39378bf00a335bac76fc3839fd0a4e/assets/icon.png" height="128" /></p>

<p align="center"><a href="https://github.com/zm-cttae/dom-inline-style-filter" target="_blank"><img src="https://img.shields.io/github/v/release/zm-cttae/dom-inline-style-filter.svg?style=flat-square&label=Release&logo=github&logoColor=cacde2&labelColor=2c2c32&color=2196f3" /></a> <a href="https://www.npmjs.com/package/dom-inline-style-filter" target="_blank"><img src="https://img.shields.io/npm/dw/dom-inline-style-filter?style=flat-square&label=Downloads&logo=npm&logoColor=cacde2&labelColor=2c2c32&color=2196f3" /></a> <a href="https://github.com/vsce-toolroom/vscode-beautify/pipelines" target="_blank"><img src="https://img.shields.io/github/actions/workflow/status/zm-cttae/dom-inline-style-filter/CI.svg?style=flat-square&label	=CI&logo=github&logoColor=cacde2&labelColor=2c2c32&color=2196f3" /></a></p>

`dom-inline-style-filter` library filters inline style declarations for a standalone DOM element tree by computed effect.

- As web developers, we would like elements that ship only with inline styling to be light so that they can be included in NPM packages.
- A main use case of this is SVG screenshots of HTML elements.
- Even after a filter algorithm to [filter out user agent styling when inlining the style](https://github.com/1904labs/dom-to-image-more/issues/70), there is some way to go with data size.

## Usage

### `dominlinestylefilter(node)`

**Parameter:** `node` - a `HTMLElement` with all style rules embedded as inline style attributes or `<style>` tags.

**Returns:** a `Promise` that resolves to `node`. Within `node`, all inline styling has been filtered to the minimum declarations that produce the same computed style.

### `dominlinestylefilter.sync(node)`

Synchronous version. Returns `node` when the styling compression is completed.

## Optimizations

1.  **When traversing DOM tree of `node`, group nodes by descending node depth.**

    CSS inheritance is computed on the DOM tree via preorder traversal and is additive-cumulative (increases styling data).
	
	For the filter op which is subtractive, we want to traverse the tree in the opposite direction.
    
    The algorithm sorts elements in the `node` tree by descending node depth. (This is known as reverse level order traversal.)

    This gives us a 30% to 40% speed boost. This also ensures declarations are only removed when they really can be inherited.

2.  **When filtering each inline style declaration by computed effect, go for the most hyphenated properties first.**

    In CSS, shorthands consistently have less hyphens than their longhand.

	We want to filter out scenarios where a CSS property matches their shorthand, e.g. `block-size` -> `height` or `border-color` -> `border`.

    The algorithm does a radix sort with bitmasks for standard, custom and vendored proprties, then subsorts by descending hyphen count.

    In tests this filtered another 50% of inline styling. We also get a 20-40% speed boost because we're not setting as many properties back.

## Performance

The underlying algorithm was determined to be a high-pass multi-pass - $N \approx 4$ - deterministic compression in two modes.

The data was collected from manual testing on the output of the `domtoimage.toSvg` function in the `dom-to-image-more` NPM package.

### Large file inputs

$O(log(N))$ growth for inputs at large filesizes $|F| >> 1e6 \text{ bytes}$.

| Wikipedia article demo    | Value                                  |
| :------------------------ | :------------------------------------- |
| Number of nodes           | 5558 nodes                             |
| Initial declaration count | 177818 (31.9 declarations / node)      |
| Pre-compression bytes     | 3.63mb                                 |
| Reductions                | [3058654, 98781, 16774, 0]             |
| Processing time           | 10316.5ms (1.86 ms/node)               |
| Total reduction           | 3.17mb                                 |
| Output declaration count  | 33643 (6.05 / node)                    |
| Post-compression bytes    | 709.4kb                                |
| Compression quotients     | [0.9698, 0.9991, 0.9999, 1]            |
| Compression ratio         | `5.117                               ` |
| Decay formula             | $1-exp(-7 / 2 \cdot N)$                |

### Graph

<img src="./assets/236925669-a3461c94-c1dd-4d42-9bd1-55484c084614.png" width="539px" />

### Small file results

$O(c \cdot N), \space c \space \approx \space 4$ growth for inputs at small filesizes $|F| << 1e6\space\text{ bytes}$.

| Code screenshot demo      | Value                                  |
| :------------------------ | :------------------------------------- |
| Number of nodes           | 420 nodes                              |
| Initial declaration count | 14933 (35.5 declarations / node)       |
| Pre-compression bytes     | 372430b                                |
| Reductions                | [275482, 40312, 0]                     |
| Processing time           | 604ms (1.6 ms / node)                  |
| Total reduction           | 315794b                                |
| Post-compression bytes    | 56636b                                 |
| Output declaration count  | 2443 (5.82 / node)                     |
| Compression quotients     | [0.872, 0.999, 1]                      |
| Total quotient (compound) | `6.575                               ` |
| Decay formula             | $1-exp(-9 / 4 \cdot N)$                |

<img src="./assets/236925730-e880fabe-426f-491e-a95f-989536c9e3bc.png" width="539px" />
