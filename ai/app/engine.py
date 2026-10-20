# Lógica de compatibilidad compartida por la API HTTP (main.py) y el servidor gRPC (grpc_server.py).
# Es la misma heurística que tenía main.py; los ajustes del motor quedan para la Fase 5.
GENRE_FAMILIES = {
    'salsa':['salsa','latin','tropical','bachata','merengue','reggaeton'],
    'dance':['electronic','edm','house','dance','disco','pop','reggaeton'],
    'urban':['reggaeton','latin','hip-hop','rap','r&b','pop','dancehall'],
    'chill':['jazz','lofi','acoustic','soul','bossa nova','indie','pop'],
    'rock':['rock','alternative','indie','pop','blues','funk']
}
VENUE_PROFILES = {'restaurant':'chill','cafe':'chill','salsa_bar':'salsa','nightclub':'dance','lounge':'chill','other':'urban'}
ACCEPT_THRESHOLD = 72


def family(genre):
    g=genre.lower()
    return next((name for name,values in GENRE_FAMILIES.items() if any(v in g for v in values)), 'urban')


def harmonic_distance(a,b):
    notes=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
    a=a.upper().replace('M','').replace('MIN','').strip(); b=b.upper().replace('M','').replace('MIN','').strip()
    if a not in notes or b not in notes: return 0.55
    d=abs(notes.index(a)-notes.index(b)); return max(0, 1-min(d,12-d)/6)


def genre_score(current_genre, requested_genre):
    current, requested = family(current_genre), family(requested_genre)
    if current == requested:
        return 1.0
    related = requested in GENRE_FAMILIES.get(current, []) or current in GENRE_FAMILIES.get(requested, [])
    return 0.55 if related else 0.15


def bpm_score(current_bpm, requested_bpm):
    return max(0, 1-abs(current_bpm-requested_bpm)/45)


def key_score(current_key, requested_key):
    return harmonic_distance(current_key, requested_key)


def venue_score(venue_type, requested_genre):
    return 1.0 if family(requested_genre) == VENUE_PROFILES.get(venue_type, 'urban') else 0.62


def build_result(venue_type, current_genre, requested_genre, current_bpm, requested_bpm, scores):
    """Combina los puntajes de cada etapa en el resultado final (aceptación, motivo y puente)."""
    current, requested = family(current_genre), family(requested_genre)
    score = round(100*(.42*scores['genre']+.30*scores['bpm']+.18*scores['key']+.10*scores['venue']))
    accepted = score >= ACCEPT_THRESHOLD
    bridge = []
    if not accepted:
        for step in (1,2):
            bpm=round(current_bpm+(requested_bpm-current_bpm)*step/3)
            bridge.append({'position':step,'genre': current if step==1 else requested,'target_bpm':bpm,'purpose':'Ajustar energía y tempo de forma gradual'})
    reason = 'La canción encaja directamente con el ambiente.' if accepted else f'Transición directa no recomendada ({score}/100). Se generó un puente de {len(bridge)} temas.'
    return {'accepted':accepted,'score':score,'reason':reason,'bridge_sequence':bridge,'profile':VENUE_PROFILES.get(venue_type,'urban')}


def evaluate(venue_type, current_genre, requested_genre, current_bpm, requested_bpm, current_key, requested_key):
    """Evaluación completa en un solo paso (la usan POST /compatibility y CheckCompatibility)."""
    scores = {
        'genre': genre_score(current_genre, requested_genre),
        'bpm': bpm_score(current_bpm, requested_bpm),
        'key': key_score(current_key, requested_key),
        'venue': venue_score(venue_type, requested_genre),
    }
    return build_result(venue_type, current_genre, requested_genre, current_bpm, requested_bpm, scores)
