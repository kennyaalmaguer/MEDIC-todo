// routes/agendaP.cjs
const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

// Función auxiliar para validar textos
function textoValido(valor, minimo, maximo) {
  return typeof valor === 'string' &&
    valor.trim().length >= minimo &&
    valor.trim().length <= maximo;
}

module.exports = function(db, client) {

  // Obtener los médicos activos
  router.get('/medicos', async (req, res) => {
    try {
      const medicos = await db.collection('usuario')
        .find(
          { rol: 'medico', activo: true },
          { projection: { nombre: 1, especialidad: 1 } }
        )
        .toArray();
      res.json(medicos);
    } catch (error) {
      console.error(error.message);
      res.status(500).json({ mensaje: 'No se pudieron cargar los médicos.' });
    }
  });

  // Obtener citas desde la colección 'agenda'
  router.get('/citas', async (req, res) => {
    try {
      const citas = await db.collection('agenda').find({}).toArray();
      res.json(citas);
    } catch (error) {
      console.error(error.message);
      res.status(500).json({ mensaje: 'No se pudieron cargar las citas.' });
    }
  });

  // Guardar una cita en la colección 'agenda'
  router.post('/citas', async (req, res) => {
    const { nombre, telefono, medico_id, fecha, hora, motivo_consulta } = req.body || {};

    if (
      !textoValido(nombre, 3, 120) ||
      !textoValido(telefono, 7, 25) ||
      !/^[0-9+()\s-]+$/.test(telefono) ||
      !textoValido(motivo_consulta, 3, 1000) ||
      typeof medico_id !== 'string' ||
      !/^[a-f0-9]{24}$/i.test(medico_id) ||
      typeof fecha !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fecha) ||
      !['09:00', '10:30', '11:00', '13:00', '15:00', '16:00', '16:30', '17:30'].includes(hora)
    ) {
      return res.status(400).json({ mensaje: 'Completa correctamente todos los campos.' });
    }

    const fecha_hora = new Date(`${fecha}T${hora}:00-06:00`);

    if (
      Number.isNaN(fecha_hora.getTime()) ||
      new Date(fecha_hora.getTime() - 6 * 3600000).toISOString().slice(0, 10) !== fecha ||
      fecha_hora <= new Date()
    ) {
      return res.status(400).json({ mensaje: 'Selecciona una fecha y hora futuras y válidas.' });
    }

    const session = client.startSession();
    const pacienteId = new ObjectId();
    const medicoId = new ObjectId(medico_id);
    const citaId = new ObjectId();
    const ahora = new Date();

    try {
      await session.withTransaction(async () => {
        const medico = await db.collection('usuario').findOne(
          { _id: medicoId, rol: 'medico', activo: true },
          { session }
        );

        if (!medico) {
          const error = new Error('El médico no está disponible.');
          error.status = 400;
          throw error;
        }

        await db.collection('paciente').insertOne({
          _id: pacienteId,
          expediente: `EXP-${pacienteId.toHexString().toUpperCase()}`,
          nombre: nombre.trim(),
          telefono: telefono.trim(),
          edad: null,
          fecha_nacimiento: null,
          genero: null,
          antecedentes: '',
          creado_en: ahora
        }, { session });

        // Guardado optimizado utilizando la colección 'agenda'
        await db.collection('agenda').insertOne({
          _id: citaId,
          paciente_id: pacienteId,
          medico_id: medicoId,
          medico_nombre: medico.nombre,
          especialidad: medico.especialidad,
          fecha,
          hora,
          fecha_hora,
          motivo_consulta: motivo_consulta.trim(),
          estado: 'pendiente',
          creado_en: ahora
        }, { session });
      });

      res.status(201).json({
        mensaje: 'Cita guardada correctamente.',
        cita_id: citaId.toHexString()
      });
    } catch (error) {
      console.error(error.message);

      if (error.code === 11000) {
        return res.status(409).json({ mensaje: 'Ese horario ya está ocupado. Elige otro.' });
      }

      res.status(error.status || 500).json({
        mensaje: error.status ? error.message : 'No se pudo guardar la cita.'
      });
    } finally {
      await session.endSession();
    }
  });


  // ===== DOCTOR DASHBOARD =====

  // Agenda del día para el doctor dashboard.
  // GET /api/agenda?fecha=YYYY-MM-DD[&medico_id=<id>]
  // Devuelve un arreglo de citas con el objeto `paciente` ya incluido.
  router.get('/agenda', async (req, res) => {
    const { fecha, medico_id } = req.query;

    if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return res.status(400).json({ mensaje: 'Fecha inválida.' });
    }

    const filtro = { fecha };
    if (medico_id !== undefined && medico_id !== '') {
      if (typeof medico_id !== 'string' || !/^[a-f0-9]{24}$/i.test(medico_id)) {
        return res.status(400).json({ mensaje: 'Médico inválido.' });
      }
      filtro.medico_id = new ObjectId(medico_id);
    }

    try {
      const citas = await db.collection('agenda').aggregate([
        { $match: filtro },
        { $sort: { hora: 1 } },
        {
          $lookup: {
            from: 'paciente',
            localField: 'paciente_id',
            foreignField: '_id',
            as: 'paciente'
          }
        },
        { $unwind: { path: '$paciente', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            medico_id: 1,
            medico_nombre: 1,
            especialidad: 1,
            fecha: 1,
            hora: 1,
            motivo_consulta: 1,
            estado: 1,
            'paciente._id': 1,
            'paciente.nombre': 1,
            'paciente.edad': 1,
            'paciente.expediente': 1,
            'paciente.antecedentes': 1
          }
        }
      ]).toArray();

      res.json(citas);
    } catch (error) {
      console.error(error.message);
      res.status(500).json({ mensaje: 'No se pudo cargar la agenda.' });
    }
  });

  // Finalizar una consulta: guarda la consulta y marca la cita como completada.
  // POST /api/citas/:id/finalizar
  router.post('/citas/:id/finalizar', async (req, res) => {
    const { id } = req.params;
    const { observaciones, prescripcion } = req.body || {};

    if (!/^[a-f0-9]{24}$/i.test(id)) {
      return res.status(400).json({ mensaje: 'Cita inválida.' });
    }
    if (!textoValido(observaciones, 1, 5000) || !textoValido(prescripcion, 1, 5000)) {
      return res.status(400).json({ mensaje: 'Escribe las observaciones y la prescripción.' });
    }

    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const cita = await db.collection('agenda').findOne(
          { _id: new ObjectId(id) },
          { session }
        );

        if (!cita) {
          const error = new Error('La cita no existe.');
          error.status = 404;
          throw error;
        }
        if (cita.estado === 'completada') {
          const error = new Error('Esta consulta ya fue finalizada.');
          error.status = 409;
          throw error;
        }

        const paciente = await db.collection('paciente').findOne(
          { _id: cita.paciente_id },
          { session }
        );
        const ahora = new Date();

        await db.collection('consultas').insertOne({
          cita_id: cita._id,
          paciente_id: String(cita.paciente_id),
          medico_id: String(cita.medico_id),
          fecha_atencion: ahora,
          motivo_consulta: cita.motivo_consulta,
          antecedentes_al_momento: (paciente && paciente.antecedentes) || '',
          observaciones_evolucion: observaciones.trim(),
          prescripcion_plan_medico: prescripcion.trim(),
          estado: 'Finalizada',
          creado_en: ahora,
          finalizado_en: ahora
        }, { session });

        await db.collection('agenda').updateOne(
          { _id: cita._id },
          { $set: { estado: 'completada' } },
          { session }
        );
      });

      res.json({ mensaje: 'Consulta finalizada correctamente.' });
    } catch (error) {
      console.error(error.message);
      res.status(error.status || 500).json({
        mensaje: error.status ? error.message : 'No se pudo guardar la consulta.'
      });
    } finally {
      await session.endSession();
    }
  });

  return router;
};