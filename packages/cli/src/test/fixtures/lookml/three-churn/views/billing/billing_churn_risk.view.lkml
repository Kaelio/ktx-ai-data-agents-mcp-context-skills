view: billing {
  sql_table_name: billing ;;
  dimension: id {
    type: number
    primary_key: yes
    sql: ${TABLE}.id ;;
  }
  dimension: past_due_days {
    type: number
    sql: ${TABLE}.past_due_days ;;
  }
  measure: churn_risk_score {
    type: average
    sql: LEAST(1.0, ${past_due_days} / 90.0) ;;
  }
}
