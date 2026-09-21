{{- define "continuum-ai.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "continuum-ai.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "continuum-ai.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "continuum-ai.labels" -}}
app.kubernetes.io/name: {{ include "continuum-ai.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: continuum-ai
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "continuum-ai.selectorLabels" -}}
app.kubernetes.io/name: {{ include "continuum-ai.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
