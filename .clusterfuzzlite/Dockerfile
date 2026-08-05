# ClusterFuzzLite build image for the JavaScript fuzz targets in fuzz/.
#
# base-builder-javascript ships Node plus Jazzer.js and the
# `compile_javascript_fuzzer` helper, which is all these targets need — see
# build.sh for why the project's own dependency tree is deliberately absent.
FROM gcr.io/oss-fuzz-base/base-builder-javascript

COPY . $SRC/apple-docs
WORKDIR $SRC/apple-docs
COPY .clusterfuzzlite/build.sh $SRC/build.sh
