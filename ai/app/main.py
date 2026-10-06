from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
import tempfile, os, requests, librosa, numpy as np

app = FastAPI(title='Smart DJ Engine', version='1.0.0')
GENRE_FAMILIES = {
    'salsa':['salsa','latin','tropical','bachata','merengue','reggaeton'],
    'dance':['electronic','edm','house','dance','disco','pop','reggaeton'],
    'urban':['reggaeton','latin','hip-hop','rap','r&b','pop','dancehall'],
    'chill':['jazz','lofi','acoustic','soul','bossa nova','indie','pop'],
    'rock':['rock','alternative','indie','pop','blues','funk']
}
VENUE_PROFILES = {'restaurant':'chill','cafe':'chill','salsa_bar':'salsa','nightclub':'dance','lounge':'chill','other':'urban'}
class Compatibility(BaseModel):
    venue_type: str = 'other'; current_genre: str; requested_genre: str
    current_bpm: float = Field(gt=0, le=300); requested_bpm: float = Field(gt=0, le=300)
    current_key: str = 'C'; requested_key: str = 'C'
class Analysis(BaseModel): audio_url: str
def family(genre):
    g=genre.lower()
    return next((name for name,values in GENRE_FAMILIES.items() if any(v in g for v in values)), 'urban')
def harmonic_distance(a,b):
    notes=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
    a=a.upper().replace('M','').replace('MIN','').strip(); b=b.upper().replace('M','').replace('MIN','').strip()
    if a not in notes or b not in notes: return 0.55
    d=abs(notes.index(a)-notes.index(b)); return max(0, 1-min(d,12-d)/6)
@app.get('/health')
def health(): return {'status':'ok','engine':'heuristic+librosa'}
@app.post('/compatibility')
def compatibility(data: Compatibility):
    current, requested=family(data.current_genre), family(data.requested_genre)
    bpm_score=max(0,1-abs(data.current_bpm-data.requested_bpm)/45)
    key_score=harmonic_distance(data.current_key,data.requested_key)
    genre_score=1.0 if current==requested else (0.55 if requested in GENRE_FAMILIES.get(current,[]) or current in GENRE_FAMILIES.get(requested,[]) else 0.15)
    venue_score=1.0 if requested==VENUE_PROFILES.get(data.venue_type,'urban') else 0.62
    score=round(100*(.42*genre_score+.30*bpm_score+.18*key_score+.10*venue_score))
    accepted=score>=72
    bridge=[]
    if not accepted:
        direction=1 if data.requested_bpm>=data.current_bpm else -1
        for step in (1,2):
            bpm=round(data.current_bpm+(data.requested_bpm-data.current_bpm)*step/3)
            bridge.append({'position':step,'genre': current if step==1 else requested,'target_bpm':bpm,'purpose':'Ajustar energía y tempo de forma gradual'})
    reason = 'La canción encaja directamente con el ambiente.' if accepted else f'Transición directa no recomendada ({score}/100). Se generó un puente de {len(bridge)} temas.'
    return {'accepted':accepted,'score':score,'reason':reason,'bridge_sequence':bridge,'profile':VENUE_PROFILES.get(data.venue_type,'urban')}
@app.post('/analyze')
def analyze(payload: Analysis):
    try:
        response=requests.get(payload.audio_url,timeout=15); response.raise_for_status()
        suffix='.audio'; f=tempfile.NamedTemporaryFile(delete=False,suffix=suffix); f.write(response.content); f.close()
        y,sr=librosa.load(f.name,mono=True,duration=90); os.unlink(f.name)
        tempo=float(librosa.beat.tempo(y=y,sr=sr)[0]); chroma=librosa.feature.chroma_cqt(y=y,sr=sr); key=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][int(np.argmax(chroma.mean(axis=1)))]
        return {'bpm':round(tempo,2),'key':key,'duration_analyzed_seconds':round(len(y)/sr,2)}
    except Exception as exc: raise HTTPException(422,detail=f'No se pudo analizar el audio: {str(exc)}')
