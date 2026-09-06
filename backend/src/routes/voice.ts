import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { sendInternalError } from "../lib/httpError";
import { safeErrorLog } from "../lib/safeError";

export const voiceRouter = Router();

// POST /voice/stt - Speech to Text
// Expects multipart/form-data with an "audio" file field
voiceRouter.post("/stt", requireAuth, async (req, res) => {
  try {
    // Check if file was uploaded. req.files is a per-field map (single upload)
    // or a flat array (single file), so narrow both shapes.
    const uploaded = Array.isArray(req.files)
      ? req.files[0]
      : req.files?.audio?.[0];
    if (!uploaded) {
      return res.status(400).json({ detail: "No audio file provided" });
    }

    const audioFile = uploaded;
    
    // Validate file type (basic check)
    const allowedTypes = ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/webm'];
    if (!allowedTypes.includes(audioFile.mimetype)) {
      return res.status(400).json({ 
        detail: "Unsupported audio format. Please use WAV, MP3, M4A, or WebM." 
      });
    }

    // TODO: Implement actual Whisper STT processing
    // For now, return a placeholder response
    // In production, you would:
    // 1. Save the audio file temporarily
    // 2. Process it with Whisper (faster-whisper or similar)
    // 3. Return the transcribed text
    
    // Placeholder implementation
    res.json({ 
      text: "[Speech-to-text not yet implemented. Please configure Whisper backend.]",
      success: false
    });
  } catch (err) {
    console.error("[voice/stt] error:", safeErrorLog(err));
    return void sendInternalError(res, err);
  }
});

// POST /voice/tts - Text to Speech
// Expects JSON with { text: string }
voiceRouter.post("/tts", requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ detail: "Text is required" });
    }

    // TODO: Implement actual Piper TTS processing
    // For now, return a placeholder response
    // In production, you would:
    // 1. Process the text with Piper TTS
    // 2. Generate audio file
    // 3. Return the audio as downloadable file or stream
    
    // Placeholder implementation
    res.json({ 
      audioUrl: "[Text-to-speech not yet implemented. Please configure Piper backend.]",
      success: false
    });
  } catch (err) {
    console.error("[voice/tts] error:", safeErrorLog(err));
    return void sendInternalError(res, err);
  }
});