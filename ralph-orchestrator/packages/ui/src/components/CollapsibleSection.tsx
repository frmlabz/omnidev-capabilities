/**
 * CollapsibleSection Component
 *
 * A reusable collapsible/accordion section component.
 */

import { useState, type ReactNode } from "react";

interface CollapsibleSectionProps {
	title: string;
	children: ReactNode;
	/** Badge to show next to the title (e.g., count) */
	badge?: string | number;
	/** Initial collapsed state */
	defaultCollapsed?: boolean;
	/** Custom class for the content container */
	contentClassName?: string;
}

export function CollapsibleSection({
	title,
	children,
	badge,
	defaultCollapsed = false,
	contentClassName = "",
}: CollapsibleSectionProps) {
	const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

	return (
		<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
			{/* Header - clickable to toggle */}
			<button
				type="button"
				onClick={() => setIsCollapsed(!isCollapsed)}
				className="w-full flex items-center justify-between p-4 sm:p-6 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors rounded-lg"
			>
				<div className="flex items-center gap-3">
					<h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100">
						{title}
					</h2>
					{badge !== undefined && (
						<span className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">
							{badge}
						</span>
					)}
				</div>
				{/* Chevron icon */}
				<svg
					className={`w-5 h-5 text-gray-500 dark:text-gray-400 transition-transform duration-200 ${
						isCollapsed ? "" : "rotate-180"
					}`}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
					aria-hidden="true"
				>
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
				</svg>
			</button>

			{/* Collapsible content */}
			<div
				className={`overflow-hidden transition-all duration-200 ${
					isCollapsed ? "max-h-0" : "max-h-[5000px]"
				}`}
			>
				<div
					className={`px-4 pb-4 sm:px-6 sm:pb-6 border-t border-gray-200 dark:border-gray-700 pt-4 ${contentClassName}`}
				>
					{children}
				</div>
			</div>
		</div>
	);
}
