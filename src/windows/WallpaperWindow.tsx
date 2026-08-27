import { useState, useEffect, useRef } from "react";

import { invoke } from "@tauri-apps/api/core";

import type { AppSettings } from "../types/settings";

interface WallpaperWindowProps {
	settings: AppSettings;
}

export function WallpaperWindow({ settings }: WallpaperWindowProps) {
	const [isPaused, setIsPaused] = useState(false);

	const videoRef = useRef<HTMLVideoElement>(null);

	const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({});

	/*
	 * Focus & battery pausing logic.
	 */
	useEffect(() => {
		let batteryInterval: ReturnType<typeof setInterval> | undefined;

		const evaluatePauseConditions = async () => {
			let pause = false;

			/*
			 * Desktop focus check.
			 */
			if (settings.pause_on_unfocus && !document.hasFocus()) {
				pause = true;
			}

			/*
			 * Battery power check.
			 */
			if (settings.pause_on_battery && !pause) {
				try {
					const onBattery = await invoke<boolean>("check_is_on_battery");

					if (onBattery) {
						pause = true;
					}
				} catch {
					if ("getBattery" in navigator) {
						try {
							const battery: any = await (navigator as any).getBattery();

							if (!battery.charging) {
								pause = true;
							}
						} catch {
							// Ignore battery API failures.
						}
					}
				}
			}

			setIsPaused(pause);
		};

		const handleFocus = () => {
			evaluatePauseConditions();
		};

		const handleBlur = () => {
			evaluatePauseConditions();
		};

		window.addEventListener("focus", handleFocus);

		window.addEventListener("blur", handleBlur);

		/*
		 * Catch AC/battery changes periodically.
		 */
		batteryInterval = setInterval(evaluatePauseConditions, 15000);

		evaluatePauseConditions();

		return () => {
			window.removeEventListener("focus", handleFocus);

			window.removeEventListener("blur", handleBlur);

			if (batteryInterval) {
				clearInterval(batteryInterval);
			}
		};
	}, [settings.pause_on_battery, settings.pause_on_unfocus]);

	/*
	 * Video playback and audio management.
	 */
	useEffect(() => {
		const video = videoRef.current;

		if (!video) {
			return;
		}

		video.volume = settings.is_muted ? 0 : settings.volume;

		if (isPaused) {
			video.pause();
		} else {
			video.play().catch(() => {});
		}
	}, [isPaused, settings.volume, settings.is_muted, settings.wallpaper_src]);

	/*
	 * Video playback watchdog.
	 */
	useEffect(() => {
		const video = videoRef.current;

		if (!video || settings.wallpaper_type !== "video") {
			return;
		}

		const resumeIfNeeded = () => {
			if (!isPaused && video.paused) {
				video.play().catch(() => {});
			}
		};

		video.addEventListener("pause", resumeIfNeeded);

		video.addEventListener("suspend", resumeIfNeeded);

		video.addEventListener("stalled", resumeIfNeeded);

		document.addEventListener("visibilitychange", resumeIfNeeded);

		const watchdog = setInterval(resumeIfNeeded, 8000);

		return () => {
			video.removeEventListener("pause", resumeIfNeeded);

			video.removeEventListener("suspend", resumeIfNeeded);

			video.removeEventListener("stalled", resumeIfNeeded);

			document.removeEventListener("visibilitychange", resumeIfNeeded);

			clearInterval(watchdog);
		};
	}, [isPaused, settings.wallpaper_type]);

	/*
	 * Keep webpage wallpaper audio synchronized.
	 */
	useEffect(() => {
		const iframe = iframeRefs.current["__wallpaper__"];

		if (!iframe?.contentWindow) {
			return;
		}

		iframe.contentWindow.postMessage(
			{
				type: "SET_AUDIO",
				volume: settings.is_muted ? 0 : settings.volume,
				isPaused,
			},
			"*",
		);
	}, [settings.volume, settings.is_muted, isPaused, settings.wallpaper_src]);

	/*
	 * Notify widgets when the wallpaper
	 * enters/leaves its paused state.
	 */
	useEffect(() => {
		for (const overlay of settings.overlays) {
			const iframe = iframeRefs.current[overlay.id];

			if (!iframe?.contentWindow) {
				continue;
			}

			iframe.contentWindow.postMessage(
				{
					type: "SET_PAUSED",
					isPaused,
				},
				"*",
			);
		}
	}, [settings.overlays, isPaused]);

	return (
		<main className="relative h-screen w-screen overflow-hidden bg-black select-none pointer-events-none">
			{/* Main wallpaper */}
			{settings.wallpaper_type === "webpage" ? (
				<iframe
					ref={(element) => {
						iframeRefs.current["__wallpaper__"] = element;
					}}
					src={settings.wallpaper_src}
					title="Wallpaper Webpage"
					className={`absolute inset-0 h-full w-full border-0 transition-opacity duration-300 ${isPaused ? "opacity-30" : "opacity-100"}`}
					sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
				/>
			) : settings.wallpaper_type === "video" ? (
				<video
					ref={videoRef}
					src={settings.wallpaper_src}
					autoPlay
					loop
					muted={settings.is_muted}
					playsInline
					className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${isPaused ? "opacity-30" : "opacity-100"}`}
				/>
			) : (
				<img
					src={settings.wallpaper_src}
					alt="Wallpaper"
					className="absolute inset-0 h-full w-full object-cover"
				/>
			)}

			{/* URL widgets */}
			{settings.overlays.map((overlay) => {
				const translateX =
					overlay.x === 0
						? "0%"
						: overlay.x === 100
							? "-100%"
							: "-50%";

				const translateY =
					overlay.y === 0
						? "0%"
						: overlay.y === 100
							? "-100%"
							: "-50%";

				return (
					<iframe
						key={overlay.id}
						ref={(element) => {
							iframeRefs.current[overlay.id] = element;
						}}
						src={overlay.url}
						title={`Wallpaper widget ${overlay.id}`}
						className="absolute border-0"
						style={{
							left: `${overlay.x}%`,
							top: `${overlay.y}%`,
							width: `${overlay.width}px`,
							height: `${overlay.height}px`,
							transform: `translate(${translateX}, ${translateY})`,
						}}
						sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
					/>
				);
			})}
		</main>
	);
}