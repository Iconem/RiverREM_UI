FROM ghcr.io/osgeo/gdal:ubuntu-small-3.8.4

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1

WORKDIR /srv
COPY requirements.txt .

# git is only needed to pip-install RiverREM from source; purge it afterwards to slim the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-pip git \
 && pip3 install --no-cache-dir git+https://github.com/opentopography/RiverREM.git \
 && pip3 install --no-cache-dir -r requirements.txt \
 && apt-get purge -y git && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /root/.cache

COPY app ./app

# DATA_DIR holds generated COGs; mount a volume here to make them permanent.
ENV DATA_DIR=/data
ENV PUBLIC_BASE=http://localhost:8000
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
