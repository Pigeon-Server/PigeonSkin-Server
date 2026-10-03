import { describe, expect, it } from 'vitest';
import { motionVoice, selectTapMotion } from './live2d';

describe('Live2D click motions', () => {
  it('matches Cubism 2 and Cubism 4 head/body groups', () => {
    expect(selectTapMotion(['head'], ['idle', 'tap_body', 'tap_head'], 'idle')).toBe('tap_head');
    expect(selectTapMotion(['Body'], ['Idle', 'TapBody'], 'Idle')).toBe('TapBody');
    expect(selectTapMotion(['Head'], ['idle', 'touch_body', 'touch_head'], 'idle')).toBe('touch_head');
  });
  it('falls back to a tap or available non-idle motion', () => {
    expect(selectTapMotion(['Head'], ['Idle', 'Tap'], 'Idle')).toBe('Tap');
    expect(selectTapMotion(['Head'], ['Idle', 'Wave'], 'Idle')).toBe('Wave');
    expect(selectTapMotion(['Head'], ['Idle'], 'Idle')).toBeUndefined();
  });
});

describe('Live2D voices', () => {
  it('reads both Cubism sound formats and leaves silent motions silent', () => {
    expect(motionVoice({ sound: 'voice/tap.mp3' })).toBe('voice/tap.mp3');
    expect(motionVoice({ Sound: 'voice/tap.wav' })).toBe('voice/tap.wav');
    expect(motionVoice({ file: 'motion.mtn' })).toBeUndefined();
  });
});
