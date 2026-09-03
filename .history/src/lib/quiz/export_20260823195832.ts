  get hasNarrationCapture() {
    return this.captureSource !== null;
  }

  /** True only if the underlying capture tracks are still live right now. */
  narrationTracksAlive(): boolean {
    if (!this.captureStream) return false;
    return this.captureStream.getAudioTracks().some((t) => t.readyState === "live");
  }

  async captureNarration(): Promise<boolean> {
    const ctx = this.ensure();
    if (!ctx) return false;
    if (this.captureSource && this.narrationTracksAlive()) return true;
    if (this.captureReady) return this.captureReady;

    this.captureReady = (async () => {
      this.captureAttempted = true;
      if (!navigator.mediaDevices?.getDisplayMedia) {
        console.warn("[audio] getDisplayMedia unsupported — narration cannot be recorded in this browser (Chrome/Edge only).");
        return false;
      }
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
          // @ts-expect-error -- Chrome-only extension, not yet in lib.dom types
          preferCurrentTab: true,
          selfBrowserSurface: "include",
        } as DisplayMediaStreamOptions);

        const audioTracks = stream.getAudioTracks();
        if (!audioTracks.length) {
          console.warn("[audio] Tab capture granted but returned no audio track (user may have unchecked 'Share tab audio').");
          stream.getTracks().forEach((t) => t.stop());
          return false;
        }

        // Do NOT stop the video track. On some Chrome versions, stopping any
        // track of a getDisplayMedia() capture session tears down the whole
        // session — including the audio track — which produces exactly the
        // "plays live, but the recorded file ends up silent" symptom. We
        // keep the full stream referenced and alive; the video track is
        // simply never read or drawn anywhere.
        this.captureStream = stream;
        this.captureSource = ctx.createMediaStreamSource(new MediaStream(audioTracks));
        this.captureSource.connect(this.voiceGain!);

        audioTracks.forEach((track) => {
          track.onended = () => {
            console.warn("[audio] Narration capture audio track ended — narration will stop being recorded until re-captured.");
            this.captureSource?.disconnect();
            this.captureSource = null;
            this.captureReady = null;
          };
        });
        stream.getVideoTracks().forEach((track) => {
          track.onended = () => {
            console.warn("[audio] Tab-share session ended (e.g. user clicked 'Stop sharing') — narration capture ended.");
            this.stopNarrationCapture();
          };
        });

        console.log(
          "[audio] Narration capture connected. Audio tracks:",
          audioTracks.length,
          audioTracks.map((t) => ({ readyState: t.readyState, muted: t.muted, enabled: t.enabled })),
        );
        return true;
      } catch (err) {
        console.warn("[audio] Narration capture was not granted:", err);
        return false;
      }
    })();

    return this.captureReady;
  }

  stopNarrationCapture() {
    this.captureSource?.disconnect();
    this.captureSource = null;
    this.captureStream?.getTracks().forEach((t) => t.stop());
    this.captureStream = null;
    this.captureReady = null;
  }