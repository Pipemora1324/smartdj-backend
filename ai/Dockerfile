FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# ffmpeg: librosa lo necesita para decodificar los previews .m4a de iTunes en /analyze.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
# requirements.lock: versiones exactas con hashes (pip-compile desde requirements.txt); solo wheels, sin setup.py.
COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes --only-binary :all: -r requirements.lock
COPY app ./app
COPY proto ./proto
# Sin privilegios de root dentro del contenedor.
RUN useradd --create-home --uid 10001 app
USER app
EXPOSE 8000 50051
CMD ["python", "-m", "app.serve"]
