# OpenSearch with the Korean analyzer (M03 §2, §10). Without it the catalog falls back to cjk_bigram.
FROM opensearchproject/opensearch:2.19.1
RUN /usr/share/opensearch/bin/opensearch-plugin install --batch analysis-nori
