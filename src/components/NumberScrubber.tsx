import { useEffect, useRef, useState } from "react";

interface NumberScrubberProps {
	value: number;
	min: number;
	max: number;
	step?: number;
	suffix?: string;
	onChange: (value: number) => void;
}

export function NumberScrubber({ value, min, max, step = 1, suffix, onChange }: NumberScrubberProps) {
	const [isDragging, setIsDragging] = useState(false);
	const dragRef = useRef<{
		startX: number;
		startValue: number;
	} | null>(null);

	useEffect(() => {
		if (!isDragging) {
			return;
		}

		const handlePointerMove = (event: PointerEvent) => {
			if (!dragRef.current) {
				return;
			}

			const delta = event.clientX - dragRef.current.startX;

			// 4 pixels of horizontal movement = one step.
			const rawValue = dragRef.current.startValue + (delta / 4) * step;

			const steppedValue = Math.round(rawValue / step) * step;

			const clamped = Math.min(Math.max(steppedValue, min), max);

			onChange(clamped);
		};

		const handlePointerUp = () => {
			setIsDragging(false);
			dragRef.current = null;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};

		window.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", handlePointerUp);

		return () => {
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerUp);
		};
	}, [isDragging, max, min, onChange, step]);

	const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) {
			return;
		}

		dragRef.current = {
			startX: event.clientX,
			startValue: value,
		};

		setIsDragging(true);

		document.body.style.cursor = "ew-resize";
		document.body.style.userSelect = "none";

		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const parsed = Number(event.target.value);

		if (!Number.isFinite(parsed)) {
			return;
		}

		onChange(Math.min(Math.max(parsed, min), max));
	};

	return (
		<div
			className={`flex h-7 min-w-0 items-center rounded-md border transition-colors ${
				isDragging ? "border-blue-500 bg-blue-500/10" : "border-slate-700 bg-slate-800 hover:border-slate-600"
			}`}
		>
			<div
				onPointerDown={handlePointerDown}
				title="Drag horizontally to adjust"
				className={`flex h-full min-w-0 flex-1 cursor-ew-resize items-center px-2 ${isDragging ? "text-blue-300" : "text-slate-200"}`}
			>
				<input
					type="number"
					value={value}
					min={min}
					max={max}
					step={step}
					onChange={handleInputChange}
					onPointerDown={(event) => {
						event.stopPropagation();
					}}
					className="w-full min-w-0 bg-transparent text-xs font-mono outline-none"
				/>
			</div>

			{suffix && <span className="pr-2 text-[10px] text-slate-500">{suffix}</span>}
		</div>
	);
}
