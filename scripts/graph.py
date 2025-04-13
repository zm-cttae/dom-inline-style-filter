from pathlib import Path
import os
from matplotlib import pyplot as plt
from scipy.optimize import curve_fit
import numpy as np

# Sample log data
logs = ['code.log', 'wikipedia.log']
for log in logs:
	p = Path(__file__).with_name(log)
	with p.open('r') as file:
		log_data = file.read()

	# Parsing the log data
	lines = log_data.strip().split('\n')
	passes = []
	deltas = []
	bytes_values = []

	isFilteringInlineStyles = False

	for line in lines:
		if 'filterWinningInlineStyles' in line:
			isFilteringInlineStyles = True
		if 'runtime(ms)' in line:
			isFilteringInlineStyles = False
		if not isFilteringInlineStyles:
			continue
		if 'filterWinningInlineStyles pass' in line:
			# Extract pass number
			pass_number = int(line.split('#')[1])
			passes.append(pass_number)
		elif 'context.delta' in line:
			# Extract delta value
			delta_value = int(line.split()[2])
			deltas.append(delta_value)
		elif 'context.bytes' in line:
			# Extract bytes value
			bytes_value = int(line.split()[2])
			bytes_values.append(bytes_value)

	# Ensure consistent lengths across arrays
	passes = [0] + passes  # Add initial pass
	deltas = [0] + deltas  # Add initial delta corresponding to pass 0
	bytes_values = bytes_values[:len(passes)]  # Match length of bytes_values with passes

	# Compute cumulative delta values
	cumulative_deltas = np.cumsum(deltas)

	# Calculate compression quotients
	compression_quotients = cumulative_deltas / cumulative_deltas[-1]

	# Exponential function for curve fitting
	def exponential_func(x, a, b, c):
		return a * np.exp(b * x) + c

	# Provide initial guesses and increase maxfev
	initial_guess = [-1, -1.9, 1]
	fitted_passes = np.arange(passes[0], passes[-1] + 0.01, 0.01)  # Passes increment by 0.01
	params, _ = curve_fit(exponential_func, passes, compression_quotients, p0=initial_guess, maxfev=5000)
	fitted_values = exponential_func(fitted_passes, *params)

	# Plot the compression quotients
	plt.figure(figsize=(6, 4))
	plt.plot(passes, compression_quotients, 'o', label='Compression Quotients', color='blue')
	polarity = '+' if params[0] > 0 else ''
	formula = f'{params[2]:.2f}{polarity}{params[0]:.2f}*exp({params[1]:.2f})'
	plt.plot(fitted_passes, fitted_values, linestyle='dashed', label=f'Exponential Fit: {formula}', color='orange')

	# Labeling
	plt.xlabel('Pass')
	plt.ylabel('Compression Quotient')
	plt.legend()
	plt.grid()

	# Show the plot
	plt.show()
