// A quiet generated soundscape; audio starts only after the sound button is pressed.
export function createAmbient() {
  const context = new AudioContext();
  const master = context.createGain(); master.gain.value = 0; master.connect(context.destination);
  const buffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
  const data = buffer.getChannelData(0);
  let previous = 0;
  for (let i = 0; i < data.length; i++) { previous = (previous + (Math.random() * 2 - 1) * .02) / 1.02; data[i] = previous * 3.5; }
  const wind = context.createBufferSource(); wind.buffer = buffer; wind.loop = true;
  const filter = context.createBiquadFilter(); filter.type = "lowpass"; filter.frequency.value = 650;
  wind.connect(filter).connect(master); wind.start();
  const bird = () => {
    if (context.state !== "running") return;
    const time = context.currentTime;
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = "sine"; oscillator.frequency.setValueAtTime(1800 + Math.random() * 700, time); oscillator.frequency.exponentialRampToValueAtTime(3400, time + .1); oscillator.frequency.exponentialRampToValueAtTime(1700, time + .22);
    gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(.08, time + .025); gain.gain.exponentialRampToValueAtTime(.001, time + .25);
    oscillator.connect(gain).connect(master); oscillator.start(time); oscillator.stop(time + .3); oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  };
  const interval = window.setInterval(bird, 4200);
  return {
    async setEnabled(enabled: boolean) { if (enabled) await context.resume(); master.gain.setTargetAtTime(enabled ? .28 : 0, context.currentTime, .3); },
    shutter() {
      if (context.state !== "running") return;
      const click = context.createBufferSource(), gain = context.createGain(); click.buffer = buffer; gain.gain.setValueAtTime(.5, context.currentTime); gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .1); click.connect(gain).connect(context.destination); click.start(); click.stop(context.currentTime + .12); click.onended = () => { click.disconnect(); gain.disconnect(); };
    },
    dispose() { clearInterval(interval); wind.stop(); void context.close(); },
  };
}
