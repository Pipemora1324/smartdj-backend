from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
import tempfile, os, requests
from app.engine import evaluate

app = FastAPI(title='Smart DJ Engine', version='1.0.0')
class Compatibility(BaseModel):
    venue_type: str = 'other'; current_genre: str; requested_genre: str
    current_bpm: float = Field(gt=0, le=300); requested_bpm: float = Field(gt=0, le=300)
    current_key: str = 'C'; requested_key: str = 'C'
class Analysis(BaseModel): audio_url: str
@app.get('/health')
def health(): return {'status':'ok','engine':'heuristic+librosa','grpc':bool(os.environ.get('AI_GRPC_PORT'))}
@app.post('/compatibility')
def compatibility(data: Compatibility):
    return evaluate(data.venue_type,data.current_genre,data.requested_genre,data.current_bpm,data.requested_bpm,data.current_key,data.requested_key)
@app.post('/analyze')
def analyze(payload: Analysis):
    # Analizar audio con librosa usa unos 400 MB: se importa solo aquí y se puede apagar con
    # AI_ENABLE_ANALYZE=false (el contenedor combinado de Render gratis lo apaga).
    if os.environ.get('AI_ENABLE_ANALYZE', 'true').lower() != 'true':
        raise HTTPException(503, detail='El análisis de audio está desactivado en este despliegue.')
    import librosa, numpy as np
    try:
        response=requests.get(payload.audio_url,timeout=15); response.raise_for_status()
        suffix='.audio'; f=tempfile.NamedTemporaryFile(delete=False,suffix=suffix); f.write(response.content); f.close()
        y,sr=librosa.load(f.name,mono=True,duration=90); os.unlink(f.name)
        tempo=float(librosa.beat.tempo(y=y,sr=sr)[0]); chroma=librosa.feature.chroma_cqt(y=y,sr=sr); key=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][int(np.argmax(chroma.mean(axis=1)))]
        return {'bpm':round(tempo,2),'key':key,'duration_analyzed_seconds':round(len(y)/sr,2)}
    except Exception as exc: raise HTTPException(422,detail=f'No se pudo analizar el audio: {str(exc)}')
