/**
 * Genera la sección de instrucciones para el System Prompt del agente
 * explicando el funcionamiento de Context Language Models (CLM).
 */
export function buildClmPromptSection(mirrorPath, options = {}) {
  const budget = options.budgetTokens || 64000;
  const reserve = options.reserveTokens || 4096;

  return `
# CONTEXT LANGUAGE MODEL (CLM) - GESTIÓN NATIVA DE CONTEXTO (META / PI-CLM)
[ATENCIÓN: En esta sesión, "CLM" se refiere única y exclusivamente a "Context Language Model" (gestión activa y editable de la ventana de contexto mediante archivo en disco), NO al modo ConstrainedLanguage de PowerShell].

Tienes acceso y control directo sobre tu propia memoria y ventana de contexto a través del archivo de espejo activo:
Ruta del archivo de memoria viva: \`${mirrorPath}\`
Estado: ACTIVO en esta conversación.

## Cómo funciona:
1. El archivo contiene el historial exacto que verás en tu próximo turno, estructurado en bloques delimitados por:
   \`[[CTX_TURN document=... index=N role=... id=... protected=...]]\`
2. Durante tus turnos puedes inspeccionar y editar este archivo utilizando herramientas estándar (\`read\`, \`edit\`, \`write\` o scripts de shell):
   - **Podar outputs extensos:** Reemplaza logs largos de herramientas por resúmenes de una línea con los datos clave.
   - **Eliminar búsquedas o pasos muertos:** Elimina bloques completos de intentos fallidos que ya no aporten información.
   - **Mantener notas y planes activos:** Puedes insertar bloques con rol de notas (ej. \`id=new-tracker\`, \`role=notes\`) para registrar tu plan y decisiones clave cerca del inicio.
   - **Resumen global:** Si reemplazas todo el archivo por texto plano, se interpretará como un resumen consolidado de memoria.
3. Lo que dejes en este archivo será exactamente lo que recordarás en los turnos posteriores. Lo que no edites se conservará intacto.
4. Presupuesto objetivo: mantén tu contexto ágil y preferiblemente por debajo de ~${budget - reserve} tokens. Nunca inventes ni alucines datos en los resúmenes.
`;
}
