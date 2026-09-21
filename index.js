require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(bodyParser.json());

// === TUS CLAVES AHORA ESTAN EN EL ARCHIVO .env (O EN LAS VARIABLES DE RENDER) ===
const META_TOKEN = process.env.META_TOKEN;
const META_PHONE_ID = process.env.META_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const NUBEFACT_URL = process.env.NUBEFACT_URL;
const NUBEFACT_TOKEN = process.env.NUBEFACT_TOKEN;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); 

const sesiones = {};

// FUNCIÓN PARA ENVIAR MENSAJES POR LA API DE FACEBOOK
async function enviarMensajeMeta(numeroDestino, texto) {
    try {
        await axios.post(
            `https://graph.facebook.com/v17.0/${META_PHONE_ID}/messages`,
            { messaging_product: "whatsapp", to: numeroDestino, type: "text", text: { body: texto } },
            { headers: { 'Authorization': `Bearer ${META_TOKEN}`, 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error("Error enviando mensaje:", error.response ? error.response.data : error.message);
    }
}

// 1. RUTA DE VERIFICACIÓN (Facebook entra aquí una vez para validar que el servidor existe)
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// 2. RUTA PRINCIPAL (Donde llegan los mensajes de tus clientes)
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Meta exige responder rápido con un 200 OK
    // --- AGREGA ESTAS DOS LÍNEAS NUEVAS ---
    console.log("\n--- LLEGÓ ALGO DE FACEBOOK ---");
    console.log(JSON.stringify(req.body, null, 2));
    // --------------------------------------
    try {
        const body = req.body;
        // Verificamos que sea un mensaje real de WhatsApp
        if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
            const mensajeOriginal = body.entry[0].changes[0].value.messages[0];
            const numeroUsuario = mensajeOriginal.from;
            const mensajeRecibido = mensajeOriginal.text.body.trim().toLowerCase();

            let estadoActual = sesiones[numeroUsuario] ? sesiones[numeroUsuario].estado : 'INICIO';

            if (mensajeRecibido === 'factura' || mensajeRecibido === 'boleta') {
                sesiones[numeroUsuario] = { tipo: mensajeRecibido, estado: 'ESPERANDO_DOCUMENTO' };
                await enviarMensajeMeta(numeroUsuario, `¡Hola! Haremos una ${mensajeRecibido}. Por favor, ingresa el ${mensajeRecibido === 'factura' ? 'RUC (11 dígitos)' : 'DNI (8 dígitos)'}:`);
            } 
            else if (estadoActual === 'ESPERANDO_DOCUMENTO') {
                const documento = mensajeRecibido.replace(/\s/g, ''); 
                const tipo = sesiones[numeroUsuario].tipo;

                if ((tipo === 'factura' && documento.length !== 11) || (tipo === 'boleta' && documento.length !== 8)) {
                    return enviarMensajeMeta(numeroUsuario, `❌ El ${tipo === 'factura' ? 'RUC debe tener 11' : 'DNI debe tener 8'} números. Intenta de nuevo:`);
                }

                await enviarMensajeMeta(numeroUsuario, `⏳ Buscando en SUNAT/RENIEC...`);
                try {
                    const endpoint = documento.length === 11 ? `https://api.apis.net.pe/v1/ruc?numero=${documento}` : `https://api.apis.net.pe/v1/dni?numero=${documento}`;
                    const respuesta = await axios.get(endpoint);
                    const nombreCliente = documento.length === 11 ? respuesta.data.nombre : `${respuesta.data.nombres} ${respuesta.data.apellidoPaterno}`;

                    sesiones[numeroUsuario].documento = documento;
                    sesiones[numeroUsuario].nombreCliente = nombreCliente;
                    sesiones[numeroUsuario].estado = 'ESPERANDO_PRODUCTO';
                    await enviarMensajeMeta(numeroUsuario, `✅ Cliente: *${nombreCliente}*\n\nDescríbeme qué vas a cobrar.`);
                } catch (error) {
                    await enviarMensajeMeta(numeroUsuario, `❌ No encontré el documento. Intenta de nuevo:`);
                }
            }
            else if (estadoActual === 'ESPERANDO_PRODUCTO') {
                await enviarMensajeMeta(numeroUsuario, `🧠 Analizando los productos...`);
                try {
                    const prompt = `
                    Eres un asistente de facturación. Analiza este pedido del cliente: "${mensajeRecibido}".
                    Regla estricta: El cliente siempre escribe en el formato "Cantidad Producto Precio_Unitario". 
                    Ejemplo: Si dice "4 pan 0.5", significa 4 panes a 0.50 CADA UNO (el precio unitario es 0.5).
                    ASUME SIEMPRE que el número final de un producto es su PRECIO UNITARIO, nunca el precio total.
                    Extrae cada producto por separado y responde EXCLUSIVAMENTE con un objeto JSON válido con este formato exacto:
                    {"valido": true, "items": [{"descripcion": "Nombre", "cantidad": 1, "precio_unitario": 0.00}]}
                    NO agregues saludos ni explicaciones, SOLO devuelve el JSON. Si es un texto sin sentido, pon "valido": false.
                    `;
                    const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });
                    const result = await model.generateContent(prompt);
                    
                    // Extraer solo el bloque JSON por si la IA añade texto extra (markdown o saludos)
                    const textoLimpiado = result.response.text();
                    const jsonMatch = textoLimpiado.match(/\{[\s\S]*\}/);
                    if (!jsonMatch) throw new Error("La IA no devolvió un JSON válido.");
                    
                    const datosIA = JSON.parse(jsonMatch[0]);

                    if (!datosIA.valido || !datosIA.items || datosIA.items.length === 0) {
                        return enviarMensajeMeta(numeroUsuario, `😕 No pude entender bien los productos. ¿Podrías ser más claro?`);
                    }

                    let totalGlobal = 0; let valorSinIgvGlobal = 0; let igvGlobal = 0;
                    let mensajeConfirmacion = `🧾 *RESUMEN DE TU PEDIDO:*\n\n`;

                    const itemsNubefact = datosIA.items.map((item, index) => {
                        const totalFila = item.cantidad * item.precio_unitario;
                        const valorSinIgvFila = totalFila / 1.18;
                        const igvFila = totalFila - valorSinIgvFila;
                        totalGlobal += totalFila; valorSinIgvGlobal += valorSinIgvFila; igvGlobal += igvFila;

                        mensajeConfirmacion += `▫️ ${item.cantidad} x ${item.descripcion.toUpperCase()} (S/ ${item.precio_unitario.toFixed(2)} c/u) = *S/ ${totalFila.toFixed(2)}*\n`;

                        return {
                            "unidad_de_medida": "NIU", "codigo": `P00${index + 1}`, "descripcion": item.descripcion.toUpperCase(),
                            "cantidad": item.cantidad.toString(), "valor_unitario": (valorSinIgvFila / item.cantidad).toFixed(2),
                            "precio_unitario": item.precio_unitario.toFixed(2), "subtotal": valorSinIgvFila.toFixed(2),
                            "tipo_de_igv": "1", "igv": igvFila.toFixed(2), "total": totalFila.toFixed(2), "anticipo_regularizacion": "false"
                        };
                    });

                    mensajeConfirmacion += `\n💰 *TOTAL A COBRAR: S/ ${totalGlobal.toFixed(2)}*\n\n¿Es correcto? Responde *S* para generar o *N* para corregir.`;

                    sesiones[numeroUsuario].pedidoTemporal = { itemsNubefact, totalGlobal, valorSinIgvGlobal, igvGlobal };
                    sesiones[numeroUsuario].estado = 'ESPERANDO_CONFIRMACION';
                    await enviarMensajeMeta(numeroUsuario, mensajeConfirmacion);
                } catch (error) {
                    console.error("🔥 ERROR EN GEMINI:", error);
                    await enviarMensajeMeta(numeroUsuario, `❌ Hubo un error procesando el pedido con IA. Intenta de nuevo.`);
                }
            }
            else if (estadoActual === 'ESPERANDO_CONFIRMACION') {
                const respuesta = mensajeRecibido.replace(/\s/g, ''); 
                if (respuesta === 's' || respuesta === 'si' || respuesta === 'sí') {
                    await enviarMensajeMeta(numeroUsuario, `⏳ Enviando datos a SUNAT...`);
                    try {
                        const pedido = sesiones[numeroUsuario].pedidoTemporal;
                        const hoy = new Date();
                        const fechaEmision = `${hoy.getDate().toString().padStart(2, '0')}-${(hoy.getMonth() + 1).toString().padStart(2, '0')}-${hoy.getFullYear()}`;
                        const tipoDoc = sesiones[numeroUsuario].tipo;

                        const comprobante = {
                            "operacion": "generar_comprobante", "tipo_de_comprobante": tipoDoc === 'factura' ? "1" : "2",
                            "serie": tipoDoc === 'factura' ? "FFF1" : "BBB1", "numero": Math.floor(Math.random() * 100000),
                            "sunat_transaction": "1", "cliente_tipo_de_documento": tipoDoc === 'factura' ? "6" : "1",
                            "cliente_numero_de_documento": sesiones[numeroUsuario].documento,
                            "cliente_denominacion": sesiones[numeroUsuario].nombreCliente, "cliente_direccion": "Lima",
                            "cliente_email": "", "fecha_de_emision": fechaEmision, "moneda": "1", "porcentaje_de_igv": "18.00",
                            "total_gravada": pedido.valorSinIgvGlobal.toFixed(2), "total_igv": pedido.igvGlobal.toFixed(2),
                            "total": pedido.totalGlobal.toFixed(2), "items": pedido.itemsNubefact 
                        };

                        const respuestaNube = await axios.post(NUBEFACT_URL, comprobante, { headers: { 'Authorization': `Bearer ${NUBEFACT_TOKEN}`, 'Content-Type': 'application/json' }});
                        sesiones[numeroUsuario].estado = 'INICIO'; 
                        await enviarMensajeMeta(numeroUsuario, `🎉 ¡Comprobante generado!\n${respuestaNube.data.enlace_del_pdf}`);
                    } catch (error) {
                        const motivo = error.response && error.response.data && error.response.data.errors ? error.response.data.errors : error.message;
                        console.error("🔥 ERROR NUBEFACT:", motivo);
                        await enviarMensajeMeta(numeroUsuario, `❌ SUNAT rechazó el comprobante.\nMotivo: ${motivo}\n\nIntenta empezar de nuevo enviando 'factura'.`);
                        sesiones[numeroUsuario].estado = 'INICIO';
                    }
                } 
                else if (respuesta === 'n' || respuesta === 'no') {
                    sesiones[numeroUsuario].estado = 'ESPERANDO_PRODUCTO';
                    await enviarMensajeMeta(numeroUsuario, `✏️ Entendido. Borré la lista anterior. Vuelve a escribir los productos:`);
                } else {
                    await enviarMensajeMeta(numeroUsuario, `🤔 Responde *S* (Sí) o *N* (No).`);
                }
            }
        }
    } catch (error) {
        console.error("Error procesando mensaje entrante:", error);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor de Meta corriendo en puerto ${PORT}`));