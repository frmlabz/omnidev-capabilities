/**
 * Loading Skeleton Components
 *
 * Animated placeholder components shown while data is loading.
 */

interface SkeletonProps {
	className?: string;
}

function Skeleton({ className = "" }: SkeletonProps) {
	return <div className={`animate-pulse bg-gray-200 dark:bg-gray-700 rounded ${className}`} />;
}

/**
 * Skeleton for DaemonCard
 */
export function DaemonCardSkeleton() {
	return (
		<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
			<div className="flex items-start justify-between">
				<div className="flex-1">
					<Skeleton className="h-5 w-32 mb-2" />
					<Skeleton className="h-4 w-48" />
				</div>
				<Skeleton className="h-6 w-16 rounded-full" />
			</div>
			<div className="mt-3 flex items-center gap-2">
				<Skeleton className="h-4 w-24" />
				<Skeleton className="h-4 w-16" />
			</div>
		</div>
	);
}

/**
 * Skeleton for PRDCard
 */
export function PRDCardSkeleton() {
	return (
		<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
			<div className="flex items-start justify-between">
				<div className="flex-1">
					<Skeleton className="h-5 w-40 mb-2" />
					<Skeleton className="h-4 w-64" />
				</div>
				<Skeleton className="h-6 w-20 rounded-full" />
			</div>
			<div className="mt-3">
				<div className="flex justify-between mb-1">
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-4 w-8" />
				</div>
				<Skeleton className="h-2 w-full rounded-full" />
			</div>
			<div className="mt-2">
				<Skeleton className="h-3 w-20" />
			</div>
		</div>
	);
}

/**
 * Grid of daemon card skeletons
 */
export function DaemonGridSkeleton({ count = 2 }: { count?: number }) {
	return (
		<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
			{Array.from({ length: count }).map((_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: Static skeleton placeholders don't reorder
				<DaemonCardSkeleton key={i} />
			))}
		</div>
	);
}

/**
 * Grid of PRD card skeletons
 */
export function PRDGridSkeleton({ count = 4 }: { count?: number }) {
	return (
		<div className="grid gap-4 md:grid-cols-2">
			{Array.from({ length: count }).map((_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: Static skeleton placeholders don't reorder
				<PRDCardSkeleton key={i} />
			))}
		</div>
	);
}
