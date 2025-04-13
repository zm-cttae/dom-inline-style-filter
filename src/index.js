const contentElement = globalThis.document.body || globalThis.document.documentElement;
const cssBlockCommentRegex = /\/\*[^*]*\*+([^/*][^*]*\*+)*\//g;
const cssDeclarationColonRegex = /;\s*(?=-*\w+(?:-\w+)*:\s*(?:[^"']*["'][^"']*["'])*[^"']*$)/g;

let removeDefaultStylesTimeoutId = null;
let tagNameDefaultStyles = {};

/**
 * Set of HTML elements that represent block-level contexts.
 * These stop the ascent of the DOM tree for default style computation.
 * @type {Set<string>}
 * @constant
 * @see https://developer.mozilla.org/en-US/docs/Web/HTML/Block-level_elements
 */
const ascentStoppers = new Set([
	'ADDRESS',
	'ARTICLE',
	'ASIDE',
	'BLOCKQUOTE',
	'DETAILS',
	'DIALOG',
	'DD',
	'DIV',
	'DL',
	'DT',
	'FIELDSET',
	'FIGCAPTION',
	'FIGURE',
	'FOOTER',
	'FORM',
	'H1',
	'H2',
	'H3',
	'H4',
	'H5',
	'H6',
	'HEADER',
	'HGROUP',
	'HR',
	'LI',
	'MAIN',
	'NAV',
	'OL',
	'P',
	'PRE',
	'SECTION',
	'SVG',
	'TABLE',
	'UL',
	// this is some non-standard ones
	'math', // intentionally lowercase, thanks Safari
	'RUBY', // in case we have a ruby element
	'svg', // in case we have an svg embedded element
	// these are ultimate stoppers in case something drastic changes in how the DOM works
	'BODY',
	'HEAD',
	'HTML',
]);

/**
 * Filter inline style declarations for a DOM element tree by computed effect.
 * Estimated inline style reduction at 80% to 90%.
 *
 * @param {HTMLElement} clone
 *      HTML clone with styling from inline attributes and embedded stylesheets only.
 *      Expects fonts and images to have been previously embedded into the page.
 * @param {Record<string, boolean>} [options]
 *      Options for the filter.
 * @param {boolean} [options.debug=false]
 *      Enable debug logging.
 * @return {Promise<HTMLElement>}
 *      A promise that resolves to the `clone` reference, now stripped of inline styling
 *      declarations without a computed effect.
 * @exports dominlinestylefilter
 */
const dominlinestylefilter = function(clone, options) {
	const context = new Context(clone, 	options || {});
	return new Promise(stageCloneWith(context))
		.then(collectTree)
		.then(sortAscending)
		.then(multiPassFilter)
		.then(unstageClone);
};

/**
 * Synchronous version of {@link onclone}.
 * @param {HTMLElement} clone HTML clone.
 * @param {Record<string, boolean>} [options] Options for the filter.
 * @param {boolean} [options.debug=false] Enable debug logging.
 * @return {HTMLElement}
 *      The `clone` reference, now stripped of inline styling
 *      declarations without a computed effect.
 */
dominlinestylefilter.sync = function(clone, options) {
	const context = new Context(clone, options || {});
	try {
		let value = execute(stageCloneWith(context));
		[collectTree, sortAscending, multiPassFilter, unstageClone]
			.forEach(function(fn) {
				value = fn(value);
			});
		return value;
	} catch(e) {
		unstageClone(context);
		throw e;
	}
};

module.exports = dominlinestylefilter;

/**
 * Process context to propagate in promise chain.
 *
 * @param {HTMLElement} clone Node with all computed styles dumped in the inline styling.
 * @param {Record<string, boolean>} options Options for the filter.
 * @constructor
 */
function Context(clone, options) {
	/** @type HTMLElement */
	this.root = clone;
	/** @type ChildNode */
	this.sibling = clone.nextSibling;
	/** @type HTMLElement | null */
	this.parent = clone.parentElement;

	/** @type HTMLElement | null */
	this.sandbox = null;
	/** @type Window */
	this.self = null;

	/** @type Node[] */
	this.tree = null;
	/** @type Node[] */
	this.stack = [];
	/** @type Node[] */
	this.pyramid = null;

	/** @type number */
	this.cutoff = null;
	/** @type number */
	this.declarations = null;
	/** @type number */
	this.bytes = null;
	/** @type number[] */
	this.depths = [];
	/** @type number */
	this.depth = null;
	/** @type number */
	this.delta = null;

	/** @type Record<string, boolean> */
	this.options = options;
	/** @type boolean */
	this.options.debug = options.debug || false;
}

/**
 * Styling data for an HTML element.
 *
 * @param {Context} context Context of the process.
 * @param {HTMLElement} element Element in the DOM tree of `clone`.
 * @constructor
 */
function Styles(context, element) {
	/** @type {Context} */
	this.context = context;
	/** @type {HTMLElement} */
	this.element = element;
	/** @type {CSSStyleDeclaration} */
	this.inline = element.style;
	/** @type {CSSStyleDeclaration} */
	this.computed = context.self.getComputedStyle(element);
}

/**
 * Promise executor function.
 * @typedef {(resolve: (value: Context) => void, reject: (reason?: string) => void) => void} Executor
 */

/**
 * Synchronously execute a promise executor function.
 *
 * @param {Executor} executor Promise executor function.
 * @return {any} Result of the executor function.
 */
function execute(executor) {
	let result;
	const resolver = (value) => {
		result = value;
	};
	const rejector = (reason) => {
		throw new Error(reason);
	};
	executor(resolver, rejector);
	return result;
}

/**
 * Creates a hidden, rendered sandbox <iframe> so we can insert & render the clone,
 * process computed styles and run the compression algorithm.
 * To make sure we match the styling, the iframe uses the original viewport
 * dimensions and document character set.
 *
 * @return {HTMLIFrameElement} {@link Context.sandbox}.
 */
function createSandbox() {
	const iframe = globalThis.document.createElementNS('http://www.w3.org/1999/xhtml', 'iframe');
	iframe.id = 'dominlinestylefilter-sandbox-' + getRandomFourDigit();
	iframe.style.visibility = 'hidden';
	iframe.style.position = 'fixed';
	iframe.style.width = '100vw';
	iframe.style.height = '100vh';

	// figure out how this document is defined (doctype and charset)
	const charsetToUse = globalThis.document.characterSet || 'UTF-8';
	const docType = globalThis.document.doctype;
	const docTypeDeclaration = docType
		? `<!DOCTYPE ${escapeHTML(docType.name)} ${escapeHTML(
			docType.publicId
		)} ${escapeHTML(docType.systemId)}`.trim() + '>'
		: '';

	contentElement.appendChild(iframe);

	return tryTechniques(
		iframe,
		docTypeDeclaration,
		charsetToUse,
		iframe.id
	);

	function getRandomFourDigit() {
		return Math.floor(Math.random() * (9999 - 1000 + 1)) + 1000;
	}

	function escapeHTML(unsafeText) {
		if (unsafeText) {
			const div = globalThis.document.createElement('div');
			div.innerText = unsafeText;
			return div.innerHTML;
		} else {
			return '';
		}
	}

	function tryTechniques(sandbox, doctype, charset, title) {
		// Try the good old-fashioned document write with all the correct attributes set
		try {
			sandbox.contentWindow.document.write(
				`${doctype}<html><head><meta charset='${charset}'><title>${title}</title></head><body></body></html>`
			);
			return sandbox;
		} catch (_) {
			// Swallow exception and fall through to next technique
		}

		const metaCharset = globalThis.document.createElement('meta');
		metaCharset.setAttribute('charset', charset);

		// Let's attempt it using srcdoc, so we can still set the doctype and charset
		try {
			const sandboxDocument = globalThis.document.implementation.createHTMLDocument(title);
			sandboxDocument.head.appendChild(metaCharset);
			const sandboxHTML = doctype + sandboxDocument.documentElement.outerHTML;
			sandbox.setAttribute('srcdoc', sandboxHTML);
			return sandbox;
		} catch (_) {
			// Swallow exception and fall through to the simplest path
		}

		// Let's attempt it using contentDocument... here we're not able to set the doctype
		sandbox.contentDocument.head.appendChild(metaCharset);
		sandbox.contentDocument.title = title;
		return sandbox;
	}
}

/**
 * Returns the default styles for a given element in the DOM tree.
 * If the styles have already been computed, it returns the cached value.
 *
 * @param {Context} context Context of the process.
 * @param {HTMLElement} sourceElement Source element to get default styles for.
 * @return {CSSStyleDeclaration} Default styles for the element.
 */
function getDefaultStyle(context, sourceElement) {
	const tagHierarchy = computeTagHierarchy(sourceElement);
	const tagKey = computeTagKey(tagHierarchy);
	if (tagNameDefaultStyles[tagKey]) {
		return tagNameDefaultStyles[tagKey];
	}

	// We haven't cached the answer for that hierachy yet, build a
	// sandbox (if not yet created), fill it with the hierarchy that
	// matters, and grab the default styles associated
	const defaultElement = constructElementHierachy(
		context.self.document,
		tagHierarchy
	);
	const defaultStyle = computeStyleForDefaults(context.self, defaultElement);
	destroyElementHierarchy(defaultElement);

	tagNameDefaultStyles[tagKey] = defaultStyle;
	return defaultStyle;

	function computeTagHierarchy(sourceNode) {
		const tagNames = [sourceNode.tagName];

		if (ascentStoppers.has(sourceNode.tagName)) {
			return tagNames;
		}

		let targetNode = sourceNode;
		while ((targetNode = targetNode.parentNode)) {
			if (targetNode.nodeType === globalThis.Node.ELEMENT_NODE) {
				const tagName = targetNode.tagName;
				tagNames.push(tagName);

				if (ascentStoppers.has(tagName)) {
					break;
				}
			}
		}

		return tagNames;
	}

	function computeTagKey(hierarchy) {
		return hierarchy
			.filter((_, i, a) => i === 0 || i === a.length - 1)
			.join(' ');
	}

	function constructElementHierachy(sandboxDocument, hierarchy) {
		let element = sandboxDocument.body;
		while (hierarchy.length > 0) {
			const childTagName = hierarchy.pop();
			const childElement = sandboxDocument.createElement(childTagName);
			element.appendChild(childElement);
			element = childElement;
		}

		// Ensure that there is some content, so that properties like margin are applied.
		// we use zero-width space to handle FireFox adding a pixel
		element.textContent = '\u200b';
		return element;
	}

	function computeStyleForDefaults(sandboxWindow, sandboxElement) {
		const style = {};
		const defaultComputedStyle = sandboxWindow.getComputedStyle(sandboxElement);

		// Copy styles to an object, making sure that 'width' and 'height' are given the default value of 'auto', since
		// their initial value is always 'auto' despite that the default computed value is sometimes an absolute length.
		Array.from(defaultComputedStyle).forEach(function(name) {
			style[name] =
				name === 'width' || name === 'height'
					? 'auto'
					: defaultComputedStyle.getPropertyValue(name);
		});
		return style;
	}

	function destroyElementHierarchy(element) {
		let targetElement = element;
		let parentElement = element.parentElement;

		while (targetElement && targetElement.tagName !== 'BODY') {
			parentElement = targetElement.parentElement;
			if (parentElement !== null) {
				parentElement.removeChild(targetElement);
			}
			targetElement = parentElement;
		}
	}
}

/**
 * Generates a new sandbox DOM for the process context and appends the clone to it.
 *
 * @param {Context} context Context of the process.
 * @return {Executor} Promise executor function.
 */
function stageCloneWith(context) {
	return (resolve, reject) => {
		context.sandbox = createSandbox();
		context.self = context.sandbox.contentWindow;
		context.self.document.body.appendChild(context.root);
		if (!context.sandbox.parentElement) {
			reject('failed to append sandbox iframe to DOM');
		}
		resolve(context);
	};
}

/**
 * Generates a list of elements in the DOM tree of `context.clone`, sorted by descending position (source order).
 *
 * @param {Context} context Context of the process.
 * @return {Context} Updated context with the tree collected.
 */
function collectTree(context) {
	const walker = context.self.document.createTreeWalker(context.root, globalThis.NodeFilter.SHOW_ELEMENT);
	context.cutoff = context.depth = 1;
	context.tree = [context.root];
	context.depths = [context.depth];
	context.stack = [];
	context.pyramid = [];
	context.declarations = context.root.style.length;
	context.bytes = context.root.style.cssText.length;

	let index = 0;
	let clone;
	while ((clone = walker.nextNode())) {
		index += 1;
		context.tree.push(clone);
		const depth = getDepth.call(context, clone, index);
		context.depths.push(depth);
		context.declarations += clone.style.length;
		context.bytes += clone.style.cssText.length;
	}

	return context;
}

/**
 * Sorts elements into ascending DOM tree ("pyramid") like the native CSSOM, because CSS inheritance is bottom-up.
 * Elements are sorted by ascending order of succession from the root then descending source order.
 * Without the sort algorithm, explicit style values matching `inherit` are removed.
 *
 * @param {Context} context Context of the process.
 * @return {Context} Updated context with the pyramid sorted.
 */
function sortAscending(context) {
	for (let depth = context.cutoff; depth > 0; depth--) {
		for (let i = 0; i < context.tree.length; i++) {
			if (context.depths[i] === depth) {
				context.pyramid.push(context.tree[i]);
			}
		}
	}
	context.tree = null;
	return context;
}

/**
 * Get the depth of an element in the DOM tree.
 * The depth is the number of ancestors in the tree, starting from 1 for the root element.
 *
 * @param {HTMLElement} element Element to calculate depth for.
 * @param {number} i Index of the element in the tree.
 * @return {number} Depth of the element.
 */
function getDepth(element, i) {
	/** @type Context */
	const context = this;
	const previous = context.tree[i - 1] || null;
	if (element.parentElement === previous) {
		context.depth += 1;
		context.stack.push(i - 1);
		if (context.depth > context.cutoff) {
			context.cutoff = context.depth;
		}
		return context.depth;
	}
	if (element.previousElementSibling === previous) {
		return context.depth;
	}
	for (let index = context.stack.length; index >= 0; index--) {
		const parentIndex = context.stack[index];
		if (context.tree[parentIndex] === element.parentElement) {
			context.depth = context.depths[parentIndex] + 1;
			context.stack = context.stack.slice(0, index + 1);
		}
	}
	return context.depth;
}

/**
 * Multi-pass inline CSS data optimization.
 *
 * @param {Context} context Context of the process.
 * @return {Context} Updated context after compression.
 */
function multiPassFilter(context) {
	let tick;
	let pass = 0;
	context.pyramid.forEach(stripBlockComments);
	context.root.querySelectorAll('style').forEach(filterWinningMediaQueries);

	if (context.options.debug) {
		tick = debugFilterAuthorInlineStyles(context);
	}

	// If there are >~64 base2 declarations, we need to filter the inline styles in a separate pass.
	if (Math.round(Math.log2(context.declarations / context.pyramid.length)) >= 6) {
		context.pyramid.forEach(filterAuthorInlineStyles.bind(null, context));

		if (context.options.debug) {
			debugFilterAuthorInlineStyles(context, tick);
		}
	}

	// Filter the inline styles again with multiple exploratory passes of DOM style computation.
	if (context.options.debug) {
		tick = debugFilterWinningInlineStyles(context, null, pass);
	}
	while (context.delta !== 0) {
		context.delta = 0;
		context.pyramid.forEach(filterWinningInlineStyles.bind(null, context));

		if (context.options.debug) {
			pass += 1;
			debugFilterWinningInlineStyles(context, null, pass);
		}
	}
	if (context.options.debug) {
		debugFilterWinningInlineStyles(context, tick);
	}

	return context;
}

/**
 * Rounds a number to 3 decimal places.
 *
 * @param {number} n Number to round.
 * @return {number} Rounded number.
 */
const roundTo3dp = n => Math.round(n * 1000) / 1000;

/**
 * Abstracted debug logging for filterAuthorInlineStyles.
 *
 * @param {Context} context Context of the process.
 * @param {number} [timestamp] Optional timestamp for performance measurement.
 * @return {number|void} Timestamp for the function execution start.
 */
function debugFilterAuthorInlineStyles(context, timestamp) {
	// [INPUT] data for the default style filter before 1st pass.
	if (!timestamp) {
		console.info('filterAuthorInlineStyles');
		console.info('context.pyramid.length', context.pyramid.length);
		console.info('context.declarations', context.declarations);
		console.info('context.bytes', context.bytes);
		return performance.now();
	}

	// [OUTPUT] declaration count, bytecount and runtime (milliseconds).
	console.info('filterAuthorInlineStyles');
	console.info('context.declarations', context.declarations);
	console.info('context.bytes', context.bytes);
	console.info('runtime(ms)', roundTo3dp(performance.now() - timestamp));
}

/**
 * Abstracted debug logging for filterWinningInlineStyles.
 *
 * @param {Context} context Context of the process.
 * @param {number} [timestamp] Optional timestamp for performance measurement.
 * @param {number} [pass] Optional pass count for logging.
 * @return {number|void} Timestamp for the function execution start.
 */
function debugFilterWinningInlineStyles(context, timestamp, pass) {
	// [INPUT] data for the inline style filter before 1st pass.
	if (pass === 0) {
		console.info('filterWinningInlineStyles');
		console.info('context.declarations', context.declarations);
		console.info('context.bytes', context.bytes);
		return performance.now();
	}

	// [PASS] iteration count and bytecount change for each pass.
	if (pass) {
		console.info('filterWinningInlineStyles', 'pass #' + pass);
	} else {
		console.info('filterWinningInlineStyles');
		console.info('runtime(ms)', roundTo3dp(performance.now() - timestamp));
	}

	// [OUTPUT] declaration count, bytecount and runtime (milliseconds).
	console.info('context.declarations', context.declarations);
	console.info('context.bytes', context.bytes);
	console.info('context.delta', context.delta);
}

/**
 * Strip block comments from inline style.
 * @param {HTMLElement} element Element to strip block comments from.
 * @return {void}
 */
function stripBlockComments(element) {
	const value = element.getAttribute('style');

	if (!cssBlockCommentRegex.test(value)) {
		return;
	}

	element.setAttribute('style', value.replace(cssBlockCommentRegex, ''));
}

/**
 * Strip inactive media queries from embedded stylesheets.
 * @param {HTMLStyleElement} style Style element to filter media queries from.
 * @return {void}
 */
function filterWinningMediaQueries(style) {
	if (style.media && !globalThis.matchMedia(style.media).matches) {
		style.parentElement.removeChild(style);
		return;
	}
	if (!style.textContent.includes('@media')) {
		return;
	}

	const mediaRuleRegex = /@media([^{]+)\{((?:(?!\}\s*\})[\s\S])*\})\s*\}/;
	let mediaRuleMatch;

	while ((mediaRuleMatch = mediaRuleRegex.exec(style.textContent))) {
		const conditionText = mediaRuleMatch[1].trim();
		const cssText = mediaRuleMatch[2].trim();
		if (globalThis.matchMedia(conditionText).matches) {
			style.textContent = style.textContent.replace(mediaRuleMatch[0], cssText);
		} else {
			style.textContent = style.textContent.replace(mediaRuleMatch[0], '');
		}
	}
}

/**
 * Cache-optimized filter to reduce an inline style to author stylesheet declarations (400ns / element).
 * Checks if the declaration matches the default and parent computed value and if so, remove.
 *
 * @param {Context} context Context of the process.
 * @param {HTMLElement} element Filtrate element in the DOM tree of `clone`.
 * @return {void}
 */
function filterAuthorInlineStyles(context, element) {
	if (!element.attributes.style) {
		return;
	}

	const styles = new Styles(context, element);
	const initialBytes = styles.inline.cssText.length;
	context.bytes -= initialBytes;

	// Disable dynamic property changes in CSS computed values.
	const animations = freezeStyleAnimations(styles);

	// If the element is not a root element, we need to check the parent computed styles.
	const parentComputedStyle = element !== context.root
		? context.self.getComputedStyle(element.parentElement)
		: null;
	const defaultStyle = getDefaultStyle(context, element);

	// Splice explicit inline style declarations that match default and parent values.
	Array.from(styles.inline)
		.sort(compareHyphenCount)
		.forEach(spliceAuthorCssStyleDeclaration.bind(null, styles, parentComputedStyle, defaultStyle));

	// Restore dynamic CSS properties.
	unfreezeStyleAnimations(styles, animations);

	const finalBytes = styles.inline.cssText.length;
	context.bytes += finalBytes;
}

/**
 * Exploratory filter to reduce an inline style to winning declarations (~1.4ms / element).
 * Destructively remove declarations and check if there is a computed value change. If so, restore.
 *
 * @param {Context} context Context of the process.
 * @param {HTMLElement} element Filtrate element in the DOM tree of `clone`.
 * @return {void}
 */
function filterWinningInlineStyles(context, element) {
	if (!element.attributes.style) {
		return;
	}

	const styles = new Styles(context, element);
	const initialBytes = styles.inline.cssText.length;
	context.bytes -= initialBytes;
	context.delta += initialBytes;

	// Disable dynamic property changes in CSS computed values.
	const animations = freezeStyleAnimations(styles);

	// Splice explicit inline style declarations without a computed effect in place.
	// By prioritising standard CSS properties & lots of hyphens, we reduce attack time & perf load.
	tokenizeCssTextDeclarations(styles.inline.cssText)
		.map(getCssTextProperty)
		.sort(compareHyphenCount)
		.forEach(spliceWinningCssTextDeclaration.bind(null, styles));

	// Restore dynamic CSS properties.
	unfreezeStyleAnimations(styles, animations);

	const finalBytes = styles.inline.cssText.length;
	context.bytes += finalBytes;
	context.delta -= finalBytes;

	if (element.getAttribute('style') === '') {
		element.removeAttribute('style');
	}
}

/** @typedef {Record<`${string}-duration`, string>} Animations */

/**
 * Hack to freeze CSS animations and transitions and prevent dynamic property changes.
 * This keeps CSS computed values constant and prevent false positives in the declaration filter.
 *
 * @param {Styles} styles Styles object for the element.
 * @return {Animations|void} Original animation durations where applicable.
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/animation-duration#auto
 */
function freezeStyleAnimations(styles) {
	let isDynamicElement = false;

	const animations = {
		'animation-duration': null,
		'transition-duration': null
	};
	for (const name in animations) {
		if (!Object.prototype.hasOwnProperty.call(animations, name)) {
			continue;
		}

		const value = styles.inline.getPropertyValue(name);

		if (!value) {
			continue;
		}

		if (['auto', '0s'].includes(value)) {
			styles.inline.removeProperty(name);
		} else {
			isDynamicElement = true;
			animations[name] = value;
			styles.inline.setProperty(name, '0s');
		}
	}

	return isDynamicElement ? animations : void 0;
}

/**
 * Restore CSS animations and transitions to their original durations.
 *
 * @param {Styles} styles Styles object for the element.
 * @param {Animations|undefined} animations Original animation durations.
 * @return {void}
 */
function unfreezeStyleAnimations(styles, animations) {
	if (!animations) {
		return;
	}
	for (const name in animations) {
		if (animations[name].length) {
			styles.inline.setProperty(name, animations[name]);
		}
	}
}

/**
 * Tokenize inline styling declarations.
 *
 * @param {string} cssText Inline style attribute value for a HTML element.
 * @return {string[]} List of inline styling declarations.
 */
function tokenizeCssTextDeclarations(cssText) {
	return cssText.replace(/;\s*$/, '').split(cssDeclarationColonRegex);
}

/**
 * Get property name from CSS declaration.
 *
 * @param {string} declaration Inline style declaration for a HTML element.
 * @return {string} CSS property for  `declaration`.
 */
function getCssTextProperty(declaration) {
	return declaration.slice(0, declaration.indexOf(':'));
}

/**
 * Sorts an array of CSS properties by the number of hyphens, keeping vendored prefixes last.
 * Optimize for compression gains and early hits by sending shorthand, vendored and custom properties last.
 *
 * @param {string} a First CSS property name.
 * @param {string} b Second CSS property name.
 * @return {number} Sort order - see {@link Array.prototype.sort}.
 */
function compareHyphenCount(a, b) {
	const isCustom = (name) => /^--\b/.test(name);
	const isVendored = (name) => /^-\b/.test(name);

	if (isCustom(a) && !isCustom(b)) {
		return 1;
	}
	if (!isCustom(a) && isCustom(b)) {
		return -1;
	}

	if (isVendored(a) && !isVendored(b)) {
		return 1;
	}
	if (!isVendored(a) && isVendored(b)) {
		return -1;
	}

	return b.split('-').length - a.split('-').length;
}

/**
 * Splices default CSS style declarations from the inline style attribute.
 *
 * @param {Styles} styles Styles object for the element.
 * @param {CSSStyleDeclaration} parentComputedStyle Computed styles of the parent element.
 * @param {CSSStyleDeclaration} defaultStyle Default styles for the element.
 * @param {string} name Name of the CSS property explicitly declared in the inline styling.
 * @return {void}
 */
function spliceAuthorCssStyleDeclaration(styles, parentComputedStyle, defaultStyle, name) {
	if (name === 'width' || name === 'height') { // cross-browser portability
		return;
	}

	const value = styles.inline.getPropertyValue(name);
	const defaultValue = defaultStyle[name];
	const parentComputedValue = parentComputedStyle
		? parentComputedStyle.getPropertyValue(name)
		: void 0;

	// If the style does not match the default, or it does not match the parent's, set it. We don't know which
	// styles are inherited from the parent and which aren't, so we have to always check both.
	if (
		(defaultValue && value === defaultValue) &&
		(!parentComputedValue || (parentComputedStyle && value === parentComputedValue))
	) {
		styles.inline.removeProperty(name);
		styles.context.declarations -= 1;
	}
}

/**
 * Filters style declarations in place to keep the algorithm deterministic.
 * The styles dumped by `filterAuthorInlineStyles` are position-dependent.
 *
 * @param {Styles} styles Styles object for the element.
 * @param {string} name Name of the CSS property explicitly declared in the inline styling.
 * @return {void}
 */
function spliceWinningCssTextDeclaration(styles, name) {
	if (name === 'width' || name === 'height') { // cross-browser portability
		return;
	}
	if (name === 'animation-duration' || name === 'transition-duration') { // dynamic property
		return;
	}

	const value = styles.inline.getPropertyValue(name);
	const declarations = tokenizeCssTextDeclarations(styles.inline.cssText);
	const index = declarations.findIndex(d => name === getCssTextProperty(d));
	if (index === -1) {
		return;
	}

	styles.inline.cssText = declarations.filter((_, i) => i !== index).join('; ') + ';';
	if (value === styles.computed.getPropertyValue(name)) {
		styles.context.declarations -= 1;
	} else {
		styles.inline.cssText = declarations.join('; ') + ';';
	}
}

/**
 * Detaches clone element from the sandbox, then deletes the sandbox <iframe>.
 *
 * @param {Context} context Context of the process.
 * @return {HTMLElement} Root element of the clone.
 */
function unstageClone(context) {
	if (context.parent) {
		context.parent.insertBefore(context.root, context.sibling);
	}
	if (context.sandbox && context.sandbox.parentElement) {
		contentElement.removeChild(context.sandbox);
	}
	if (context.sandbox) {
		context.self = null;
		context.sandbox = null;
	}

	if (removeDefaultStylesTimeoutId) {
		clearTimeout(removeDefaultStylesTimeoutId);
	}

	removeDefaultStylesTimeoutId = setTimeout(() => {
		removeDefaultStylesTimeoutId = null;
		tagNameDefaultStyles = {};
	}, 20 * 1000);

	return context.root;
}
