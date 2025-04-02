const contentElement = globalThis.document.body || globalThis.document.documentElement;
const cssBlockCommentRegex = /\/\*[^*]*\*+([^/*][^*]*\*+)*\//g;
const cssDeclarationColonRegex = /;\s*(?=-*\w+(?:-\w+)*:\s*(?:[^"']*["'][^"']*["'])*[^"']*$)/g;

/**
 * Filter inline style declarations for a DOM element tree by computed effect.
 * Estimated inline style reduction at 80% to 90%.
 *
 * @param {HTMLElement} clone
 *      HTML clone with styling from inline attributes and embedded stylesheets only.
 *      Expects fonts and images to have been previously embedded into the page.
 * @returns {Promise<HTMLElement>}
 *      A promise that resolves to the `clone` reference, now stripped of inline styling
 *      declarations without a computed effect.
 * @exports dominlinestylefilter
 */
const dominlinestylefilter = function(clone) {
	const context = new Context(clone);
	return new Promise(stageCloneWith(context))
		.then(collectTree)
		.then(sortAscending)
		.then(multiPassFilter)
		.then(unstageClone);
};

/**
 * Synchronous version of {@link onclone}.
 * @param {HTMLElement} clone
 * @returns {HTMLElement}
 */
dominlinestylefilter.sync = function(clone) {
	const context = new Context(clone);
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
 * Process context to propogate in promise chain.
 * @param {HTMLElement} clone
 *      Node with all computed styles dumped in the inline styling.
 * @constructor
 */
function Context(clone) {
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
	/** @type number[] */
	this.depths = [];
	/** @type number */
	this.depth = null;
	/** @type number */
	this.delta = null;
}

/**
 * Styling data for a HTML element.
 * @param {HTMLElement} element Element in the DOM tree of clone.
 * @param {Context} context
 * @constructor
 */
function Styles(element, context) {
	/** @type CSSStyleDeclaration */
	this.inline = element.style;
	/** @type CSSStyleDeclaration */
	this.computed = context.sandbox.contentWindow.getComputedStyle(element);
}

/**
 * Promise executor function.
 * @typedef {(resolve: (value: Context) => void, reject: (reason?: string) => void) => void} Executor
 */

/**
 * Synchronously execute a promise executor function.
 * @param {Executor} executor
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
 * @returns {HTMLIFrameElement} {@link Context.sandbox}.
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
		// try the good old-fashioned document write with all the correct attributes set
		try {
			sandbox.contentWindow.document.write(
				`${doctype}<html><head><meta charset='${charset}'><title>${title}</title></head><body></body></html>`
			);
			return sandbox;
		} catch (_) {
			// swallow exception and fall through to next technique
		}

		const metaCharset = globalThis.document.createElement('meta');
		metaCharset.setAttribute('charset', charset);

		// let's attempt it using srcdoc, so we can still set the doctype and charset
		try {
			const sandboxDocument = globalThis.document.implementation.createHTMLDocument(title);
			sandboxDocument.head.appendChild(metaCharset);
			const sandboxHTML = doctype + sandboxDocument.documentElement.outerHTML;
			sandbox.setAttribute('srcdoc', sandboxHTML);
			return sandbox;
		} catch (_) {
			// swallow exception and fall through to the simplest path
		}

		// let's attempt it using contentDocument... here we're not able to set the doctype
		sandbox.contentDocument.head.appendChild(metaCharset);
		sandbox.contentDocument.title = title;
		return sandbox;
	}
}

/**
 * Generates a new sandbox DOM for the process context and appends the clone to it.
 *
 * @param {Context} context
 * @returns {Executor} Promise executor function.
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
 * @param {Context} context
 */
function collectTree(context) {
	const walker = context.self.document.createTreeWalker(context.root, globalThis.NodeFilter.SHOW_ELEMENT);
	context.cutoff = context.depth = 1;
	context.tree = [context.root];
	context.depths = [context.depth];
	context.stack = [];
	context.pyramid = [];

	let index = 0;
	let clone;
	while ((clone = walker.nextNode())) {
		index += 1;
		context.tree.push(clone);
		const depth = getDepth.call(context, clone, index);
		context.depths.push(depth);
	}

	return context;
}

/**
 * Sorts elements into ascending DOM tree ("pyramid") like the native CSSOM, because CSS inheritance is bottom-up.
 * Elements are sorted by ascending order of succession from the root then descending source order.
 * Without the sort algorithm, explicit style values matching `inherit` are removed.
 * @param {Context} context
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
 * Transform .
 * @param {HTMLElement} element
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

/** Multi-pass inline CSS data optimization. */
function multiPassFilter(context) {
	context.pyramid.forEach(stripBlockComments);
	context.root.querySelectorAll('style').forEach(filterWinningMediaQueries);

	while (context.delta !== 0) {
		context.delta = 0;
		context.pyramid.forEach(filterWinningInlineStyles.bind(context));
	}

	return context;
}

/**
 * Strip block comments from inline style.
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
 * Exploratory filter to reduce an inline style to winning declarations (<2ms / element).
 * Destructively remove declarations and check if there is a computed value change. If so, restore.
 *
 * @param {HTMLElement} element
 *      Element in the DOM tree of `clone`.
 * @this {Context}
 */
function filterWinningInlineStyles(element) {
	if (!element.attributes.style) {
		return;
	}

	const styles = new Styles(element, this);
	this.delta += styles.inline.cssText.length;

	// Hack to disable dynamic changes in CSS computed values.
	// Prevents false positives in the declaration filter.
	const animations = { 'animation-duration': '', 'transition-duration': '' };
	for (const name in animations) {
		if (Object.prototype.hasOwnProperty.call(animations, name)) {
			if (!animations[name]) {
				continue;
			}

			animations[name] = styles.inline.getPropertyValue(name);
			styles.inline.setProperty(name, '0s');
		}
	}

	// Splice explicit inline style declarations without a computed effect in place.
	// By prioritising standard CSS properties & lots of hyphens, we reduce attack time & perf load.
	tokenizeCssTextDeclarations(styles.inline.cssText)
		.map(getCssTextProperty)
		.sort(compareHyphenCount)
		.forEach(spliceCssTextDeclaration.bind(styles));

	// Restore dynamic CSS properties.
	for (const name in animations) {
		if (animations[name].length) {
			styles.inline.setProperty(name, animations[name]);
		}
	}

	this.delta -= styles.inline.cssText.length;

	if (element.getAttribute('style') === '') {
		element.removeAttribute('style');
	}
}

/**
 * Tokenize inline styling declarations.
 *
 * @param {string} cssText
 *      Inline style attribute value for a HTML element.
 * @returns {string[]}
 *      List of inline styling declarations.
 */
function tokenizeCssTextDeclarations(cssText) {
	return cssText.replace(/;\s*$/, '').split(cssDeclarationColonRegex);
}

/**
 * Get property name from CSS declaration.
 *
 * @param {string} declaration
 *      Inline style declaration for a HTML element.
 * @returns {string}
 *      The CSS property for `declaration`.
 */
function getCssTextProperty(declaration) {
	return declaration.slice(0, declaration.indexOf(':'));
}

/**
 * Sorts an array of CSS properties by the number of hyphens, keeping vendored prefixes last.
 * Optimize for compression gains and early hits by sending shorthand, vendored and custom properties last.
 *
 * @param {string} a
 *      First CSS property name.
 * @param {string} b
 *      Second CSS property name.
 * @returns {number}
 *      See {@link Array.prototype.sort}.
 */
function compareHyphenCount(a, b) {
	const isCustom = (name) => /^--\b/.test(name);
	const isVendored = (name) => /^-\b/.test(name);

	return (
		(isCustom(a) & !isCustom(b)) * 0b1000000 |
		(isVendored(a) & !isVendored(b)) * 0b0100000 |
		Math.min(b.split('-').length - a.split('-').length, 0b0011111)
	);
}

/**
 * Filters style declarations in place to keep the algorithm deterministic.
 * The styles dumped by `copyUserComputedStyleFast` are position-dependent.
 *
 * @param {string} name
 *      Name of the CSS property explicitly declared in the inline styling.
 * @this {Styles}
 */
function spliceCssTextDeclaration(name) {
	if (name === 'width' || name === 'height') { // cross-browser portability
		return;
	}
	if (name === 'animation-duration' || name === 'transition-duration') { // dynamic property - line :256
		return;
	}

	const value = this.inline.getPropertyValue(name);
	const declarations = tokenizeCssTextDeclarations(this.inline.cssText);
	const index = declarations.findIndex(d => name === getCssTextProperty(d));
	if (index === -1) {
		return;
	}

	this.inline.cssText = declarations.filter((_, i) => i !== index).join('; ') + ';';
	if (value === this.computed.getPropertyValue(name)) {
		return;
	}
	this.inline.cssText = declarations.join('; ') + ';';
}

/**
 * Detaches clone element from the sandbox, then deletes the sandbox <iframe>.
 * @param {Context} context
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
	return context.root;
}
