['code.svg', 'wikipedia.svg'].forEach(async image => {
	const iframe =  document.querySelector('iframe#test-bench');

	const request = new XMLHttpRequest();
	request.open('GET', '/base/test/resources/' + image, false);
	request.send();

	iframe.src = '/base/test/resources/' + image;

	const root = iframe.contentDocument.querySelector('foreignElement > *');

	const getCachedDeclaration = (transformer) => () => {
		return [root, ...root.querySelector('*')]
			.map(transformer)
			.map(decl => Object.assign({}, decl));
	};

	const computedStylesFn = getCachedDeclaration(el => getComputedStyle(el));
	const inlineStylesFn = getCachedDeclaration(el => el.style);

	const info = console.info;
	const buffer = [];
	const infoSpy = function() {
		buffer.push(...arguments);
		info.call(console, ...arguments);
	};
	console.info = infoSpy;

	const computedStylesBefore = computedStylesFn();

	await dominlinestylefilter(root, { debug: true });

	console.info = info;

	const generalData = {};
	const authorData = { bytes: [], declarations: [] };
	const activeData = { bytes: [], declarations: [], deltas: [] };
	let isInActiveFilter = false;

	for (const line of buffer) {
		if (line === 'filterActiveInlineStyles') {
			isInActiveFilter = true;
		}
		if (!isInActiveFilter && line.startsWith('context.pyramid.length')) {
			generalData.elements = parseFloat(line.match(/\d+$/));
		}
		if (!isInActiveFilter && line.startsWith('runtime')) {
			authorData.runtime = parseFloat(line.match(/\d+$/));
		}
		if (!isInActiveFilter && line.startsWith('context.bytes')) {
			authorData.bytes.push(parseFloat(line.match(/\d+$/)));
		}
		if (!isInActiveFilter && line.startsWith('context.declarations')) {
			authorData.declarations.push(parseFloat(line.match(/\d+$/)));
		}
	
		if (isInActiveFilter && line.startsWith('runtime')) {
			activeData.runtime = parseFloat(line.match(/\d+$/));
			break;
		}
		if (isInActiveFilter && line.startsWith('context.bytes')) {
			activeData.bytes.push(parseFloat(line.match(/\d+$/)));
		}
		if (isInActiveFilter && line.startsWith('context.declarations')) {
			activeData.declarations.push(parseFloat(line.match(/\d+$/)));
		}
		if (isInActiveFilter && line.startsWith('context.delta')) {
			activeData.deltas.push(parseFloat(line.match(/\d+$/)));
		}
	}

	describe(image + ' compression results', function() {
		it('filters 80% or more properties', function() {
			const len = activeData.declarations.length - 1;
			const delta = authorData.declarations[0] - activeData.declarations[len];
			const total = authorData.declarations[0];
			const quotientInPc = 100 * (1 - delta / total);
			assert(quotientInPc >= 80);
		});

		it('saves 80% of styling data bytecount', function() {
			const len = activeData.bytes.length - 1;
			const difference = authorData.bytes[0] - activeData.bytes[len];
			const total = authorData.bytes[0];
			const quotientInPc = 100 * (1 - difference / total);
			assert(quotientInPc >= 80);
		});

		it('longest property excluding vars has 5 hyphens', function() {
			const declarations = inlineStylesFn();
			for (const declaration of declarations) {
				const maxHyphenCount = Object.keys(declaration)
					.filter(prop => typeof prop === 'string')
					.filter(prop => !prop.startsWith('-'))
					.map(prop => prop.split('-').length)
					.reduce((a, b) => Math.max(a, b),);
				expect(maxHyphenCount <= 5).to.be.true;
			}
		});

		it('has a runtime of below 4ms/element in the author filter', function() {
			const count = generalData.elements;
			const runtime = authorData.runtime;
			expect(runtime / count).to.be.at.most(4);
		});

		it('has a runtime of below 8ms/element in the active filter', function() {
			const count = generalData.elements;
			const runtime = activeData.runtime;
			expect(runtime / count).to.be.at.most(8);
		});

		it('has a runtime of below 3x of the author filter in the active filter', function() {
			const count = generalData.elements;
			const authorTimeCost = authorData.runtime / count;
			const activeTimeCost = authorData.runtime / count;
			expect(activeTimeCost / authorTimeCost).to.be.at.most(3);
		});

		it('has 4 or less passes in the active filter', function() {
			const passes = activeData.deltas.length;
			expect(passes).to.be.at.most(4);
		});

		it('has each delta less than the previous delta in the active filter', function() {
			for (i = 2; i < activeData.deltas.length; i++) {
				const lastDelta = activeData.deltas[i - 1];
				const currentDelta = activeData.deltas[i];
				expect(currentDelta).to.be.at.most(lastDelta);
			}
		});

		it('removes extraneous box model size properties', function() {
			const declarations = inlineStylesFn();
			for (const declaration of declarations) {
				const properties = Object.keys(declaration);
				expect('block-size' in properties).to.equal.false;
				expect('inline-size' in properties).to.equal.false;
			}
		});

		it('removes extraneous box model margin properties', function() {
			const declarations = inlineStylesFn();
			for (const declaration of declarations) {
				const properties = Object.keys(declaration);
				expect('margin-block-start' in properties).to.equal.false;
				expect('margin-block-end' in properties).to.equal.false;
				expect('margin-inline-start' in properties).to.equal.false;
				expect('margin-inline-end' in properties).to.equal.false;
			}
		});

		it('keeps computed visual results consistent', function() {
			const filtrates = computedStylesBefore;
			const results = computedStylesFn();

			for (let index = 0; index < filtrates.length; index++) {
				const declarationBefore = filtrates[index];
				const declarationAfter = results[index];

				for (const prop in declarationBefore) {
					const valueBefore = declarationBefore[prop];
					const valueAfter = declarationAfter[prop];

					expect(valueAfter).to.equal(valueBefore);
				}
			}
		});

		it('produces determinate results across runs', function() {
			const prevBuffer = structuredClone(buffer);

			const info = console.info;
			console.info = infoSpy;
			buffer = [];

			await dominlinestylefilter(root, { debug: true });
			
			console.info = info;
			
			let isInAuthorResult = 0;
			let isInActiveResult = 0;

			for (index = 0; index < buffer.length; index++) {
				if (line === 'filterAuthorInlineStyles') {
					isInAuthorResult = isInAuthorResult + 1;
					continue;
				}

				if (line === 'filterActiveInlineStyles') {
					isInAuthorResult = 0;
					isInActiveResult = isInActiveResult + 1;
					continue;
				}

				const line = buffer[index];
				const prevLine = prevBuffer[index];

				if ((isInAuthorResult + isInActiveResult) === 2) {
					if (line.startsWith('runtime')) {
						const timeAfter = line.match(/\d+/);
						const timeBefore = prevLine.match(/\d+/);
						const difference = (timeAfter - timeBefore) / timeBefore;
						expect(difference).to.be.below(0.2).above(-0.2);
					} else {
						expect(line).to.equal(prevLine);
					}
				}
			}
		});
	});
});