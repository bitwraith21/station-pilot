use std::cell::RefCell;

struct Processor {
    io: Vec<f32>,
    delay: Vec<[f32; 2]>,
    delay_index: usize,
    gain: f32,
    release: f32,
    source: [Vec<f32>; 2],
    position: f64,
    target: f64,
    envelope: f32,
    stopped: bool,
    speed: f64,
    smoothing: f64,
}

impl Default for Processor {
    fn default() -> Self {
        Self {
            io: Vec::new(),
            delay: Vec::new(),
            delay_index: 0,
            gain: 1.0,
            release: 0.0,
            source: [Vec::new(), Vec::new()],
            position: 0.0,
            target: 0.0,
            envelope: 0.0,
            stopped: false,
            speed: 0.0,
            smoothing: 0.0,
        }
    }
}

thread_local! { static DSP: RefCell<Processor> = RefCell::new(Processor::default()); }

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    DSP.with(|dsp| {
        let mut dsp = dsp.borrow_mut();
        dsp.delay = vec![[0.0; 2]; (sample_rate * 0.005).ceil().max(1.0) as usize];
        dsp.release = (-1.0 / (sample_rate * 0.09)).exp();
        dsp.smoothing = 1.0 - (-1.0 / (f64::from(sample_rate) * 0.002)).exp();
    });
}

#[no_mangle]
pub extern "C" fn audio_io(frames: usize) -> *mut f32 {
    DSP.with(|dsp| {
        let mut dsp = dsp.borrow_mut();
        dsp.io.resize(frames * 2, 0.0);
        dsp.io.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn scratch_load(samples: usize, position: f64) {
    DSP.with(|dsp| {
        let mut dsp = dsp.borrow_mut();
        for channel in &mut dsp.source {
            channel.resize(samples, 0.0);
        }
        dsp.stopped = true;
        dsp.position = position;
    });
}

#[no_mangle]
pub extern "C" fn scratch_start(position: f64) {
    DSP.with(|dsp| {
        let mut dsp = dsp.borrow_mut();
        dsp.position = position;
        dsp.speed = 0.0;
        dsp.target = position;
        dsp.envelope = 0.0;
        dsp.stopped = false;
    });
}

#[no_mangle]
pub extern "C" fn scratch_channel(channel: usize) -> *mut f32 {
    DSP.with(|dsp| dsp.borrow_mut().source[channel].as_mut_ptr())
}

#[no_mangle]
pub extern "C" fn scratch_target(position: f64) {
    DSP.with(|dsp| dsp.borrow_mut().target = position);
}

#[no_mangle]
pub extern "C" fn scratch_stop() {
    DSP.with(|dsp| dsp.borrow_mut().stopped = true);
}

#[no_mangle]
pub extern "C" fn render_scratch(frames: usize) {
    DSP.with(|dsp| {
        let mut dsp = dsp.borrow_mut();
        let Processor { io, source, position, target, envelope, stopped, smoothing, speed, .. } = &mut *dsp;
        if source[0].is_empty() || (*stopped && *envelope < 0.0001) {
            io.fill(0.0);
            return;
        }
        let desired = if *stopped { 0.0 } else { ((*target - *position) / frames as f64).clamp(-12.0, 12.0) };
        let last = source[0].len() - 1;
        for frame in 0..frames {
            *speed += (desired - *speed) * *smoothing;
            let previous = *position;
            *position = (*position + *speed).clamp(0.0, last as f64);
            let gain = if *stopped { 0.0 } else { (speed.abs() * 16.0).min(1.0) as f32 };
            *envelope += (gain - *envelope) * *smoothing as f32;
            // Average along fast strokes to attenuate frequencies above the output bandwidth.
            let taps = speed.abs().ceil().clamp(1.0, 12.0) as usize;
            for channel in 0..2 {
                let audio = &source[channel];
                let mut sum = 0.0;
                for tap in 1..=taps {
                    let p = previous + (*position - previous) * (tap as f64 / taps as f64);
                    let n = p as usize;
                    let t = (p - n as f64) as f32;
                    let a = audio[n.saturating_sub(1)];
                    let b = audio[n];
                    let c = audio[(n + 1).min(last)];
                    let d = audio[(n + 2).min(last)];
                    sum += b + 0.5 * t * (c - a + t * (2.0*a - 5.0*b + 4.0*c - d + t * (3.0*(b-c) + d-a)));
                }
                io[channel * frames + frame] = sum / taps as f32 * *envelope;
            }
        }
    });
}

#[no_mangle]
pub extern "C" fn render_limiter(frames: usize) -> u32 {
    const CEILING: f32 = 0.707_945_76;
    DSP.with(|dsp| {
        let mut dsp = dsp.borrow_mut();
        let Processor { io, delay, delay_index, gain, release, .. } = &mut *dsp;
        for frame in 0..frames {
            let now = [io[frame], io[frames + frame]];
            let pending = delay[*delay_index];
            let peak = now[0].abs().max(now[1].abs()).max(pending[0].abs()).max(pending[1].abs());
            let ceiling_gain = if peak > CEILING { CEILING / peak } else { 1.0 };
            *gain = ceiling_gain.min(1.0 - (1.0 - *gain) * *release);
            io[frame] = pending[0] * *gain;
            io[frames + frame] = pending[1] * *gain;
            delay[*delay_index] = now;
            *delay_index += 1;
            if *delay_index == delay.len() {
                *delay_index = 0;
            }
        }
        u32::from(*gain < 0.985)
    })
}
